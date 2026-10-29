import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CupsClient} from './ipp.js';

const printerIcon = 'printer-symbolic';
const warningIcon = 'printer-warning-symbolic';
const errorIcon = 'printer-error-symbolic';

function exec_command(args) {
    try {
        Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    }
    catch (e) {
        logError(e);
    }
}

// A printer-state-reasons keyword without a -report or -warning suffix is an
// error (RFC 8011), except for these, which only say what CUPS is doing
// ('paused': stopped by the user)
const notErrorReasons = ['none', 'paused', 'moving-to-paused', 'connecting-to-device'];

function isErrorReason(reason) {
    return !notErrorReasons.includes(reason) && !reason.startsWith('cups-') &&
        !reason.endsWith('-report') && !reason.endsWith('-warning');
}

// For example toner-low-warning or media-low-warning
function isWarningReason(reason) {
    return reason.endsWith('-warning');
}

// media-empty-error -> "Media empty"
function describeReason(reason) {
    let text = reason.replace(/-(error|warning|report)$/, '').replace(/-/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function PopupIconMenuItem(icon, label) {
    let _item = new PopupMenu.PopupImageMenuItem(label, icon, {});
    return _item;
}

const PrintersManager = GObject.registerClass(class PrintersManager extends PanelMenu.Button {

    _init(settings) {
        super._init(null, 'PrintersManager')
        this.connect_to = 0;
        this.show_icon = 0;
        this.show_error = true;
        this.show_jobs = true;
        this.job_number = true;
        this.send_to_front = true;
        this.printError = false;
        this.printWarning = false;
        this.updating = false;
        this.menuIsOpen = false;
        this._refreshNeeded = false;
        this._retryTimeout = 0;
        this._signalTimeout = 0;
        this._cupsUnavailable = false;
        this._settings = settings;
        this._cups = new CupsClient();
        this._settingsChangedId = this._settings.connect('changed', this.onSettingsChanged.bind(this));

        let hbox = new St.BoxLayout({style_class: 'panel-status-menu-box' });
        this._icon = new St.Icon({icon_name: printerIcon, style_class: 'system-status-icon'});
        this._jobs = new St.Label({y_align: Clutter.ActorAlign.CENTER, text: ''});

        hbox.add_child(this._icon);
        hbox.add_child(this._jobs);
        this.add_child(hbox);

        this.menu.connect('open-state-changed', (self, open) => {
            this.menuIsOpen = open;
            if(!open) this.runRefresh();
        });

        this._cupsSignal = Gio.DBus.system.signal_subscribe(null, 'org.cups.cupsd.Notifier', null, '/org/cups/cupsd/Notifier', null, Gio.DBusSignalFlags.NONE, this.onCupsSignal.bind(this));

        this.queueRefresh();
    }

    destroy() {
        this._destroyed = true;
        if(this._cupsSignal) {
            Gio.DBus.system.signal_unsubscribe(this._cupsSignal);
            this._cupsSignal = 0;
        }
        if(this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if(this._retryTimeout) {
            GLib.Source.remove(this._retryTimeout);
            this._retryTimeout = 0;
        }
        if(this._signalTimeout) {
            GLib.Source.remove(this._signalTimeout);
            this._signalTimeout = 0;
        }
        this._cups.destroy();
        super.destroy();
    }

    onShowPrintersClicked() {
        if(this.connect_to == 0) exec_command(['gnome-control-center', 'printers']);
        else exec_command(['system-config-printer']);
    }

    onShowJobsClicked(item) {
        exec_command(['system-config-printer', '--show-jobs', item.printer]);
    }

    onCancelAllJobsClicked() {
        for(let n = 0; n < this.printers.length; n++) exec_command(['cancel', '-a', this.printers[n]]);
    }

    onCancelJobClicked(item) {
        exec_command(['cancel', item.job]);
    }

    onSendToFrontClicked(item) {
        exec_command(['lp', '-i', item.job, '-q 100']);
    }

    async refresh() {
        this.updating = true;
        try {
            await this.updateMenu();
        }
        catch (e) {
            if(!this._destroyed) this.showUnavailable(e);
        }
        finally {
            this.updating = false;
        }
    }

    // CUPS can't be reached (not running, or not started yet). No CUPS signals
    // arrive while it's down, so retry until a refresh succeeds.
    showUnavailable(e) {
        if(!this._cupsUnavailable) logError(e); // log once, not on every retry
        this._cupsUnavailable = true;
        this.menu.removeAll();
        let printers = PopupIconMenuItem(printerIcon, _('Printers'));
        printers.connect('activate', this.onShowPrintersClicked.bind(this));
        this.menu.addMenuItem(printers);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Printing service unavailable'), {reactive: false}));
        this._jobs.text = '';
        this.updateIcon();
        this.show(); // even with "show icon" set to printers/jobs only, so the error is visible
        if(!this._retryTimeout) this._retryTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._retryTimeout = 0;
            this.queueRefresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    updateIcon() {
        if(this._cupsUnavailable) this._icon.icon_name = errorIcon;
        else if(this.show_error && this.printError) this._icon.icon_name = errorIcon;
        else if(this.show_error && this.printWarning) this._icon.icon_name = warningIcon;
        else this._icon.icon_name = printerIcon;
    }

    async updateMenu() {
        this.connect_to = this._settings.get_enum('connect-to');
        this.show_icon = this._settings.get_enum('show-icon');
        this.show_error = this._settings.get_boolean('show-error');
        this.show_jobs = this._settings.get_boolean('show-jobs');
        this.job_number = this._settings.get_boolean('job-number')
        this.send_to_front = this._settings.get_boolean('send-to-front')

        let [p_list, p_default, p_jobs] = await Promise.all([
            this._cups.getPrinters(),
            this._cups.getDefaultPrinter(),
            this._cups.getJobs(),
        ]);
        if(this._destroyed) return;
        this._cupsUnavailable = false;

        this.menu.removeAll();
        let printers = PopupIconMenuItem(printerIcon, _('Printers'));
        printers.connect('activate', this.onShowPrintersClicked.bind(this));
        this.menu.addMenuItem(printers);
        // Only direct queues: implicitclass (cups-browsed) queues never get the printer's reasons.
        // CUPS may hide device-uri from non-admins: then use the reasons anyway.
        let p_direct = p_list.filter(p => !p['device-uri']?.[0]?.startsWith('implicitclass:'));
        //Printers with errors or warnings, so it's clear which printer the icon is about
        let p_problems = p_direct.map(p => {
            let reasons = p['printer-state-reasons'];
            let reason = reasons.find(isErrorReason) ?? reasons.find(isWarningReason);
            return {p, reason};
        }).filter(({reason}) => reason);
        if(p_problems.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for(let {p, reason} of p_problems) {
                let printer = p['printer-name'][0];
                // The reason, not printer-state-message: the message may describe
                // another reason or be left over from a job, and wouldn't match the icon
                let message = describeReason(reason);
                let problemItem = PopupIconMenuItem(isErrorReason(reason) ? errorIcon : warningIcon, printer + ': ' + message);
                problemItem.printer = printer;
                problemItem.connect('activate', this.connect_to == 1 ? this.onShowJobsClicked.bind(this) : this.onShowPrintersClicked.bind(this));
                this.menu.addMenuItem(problemItem);
            }
        }
        //Add Printers
        this.printers = p_list.map(p => p['printer-name'][0]);
        this.printersCount = this.printers.length;
        if(this.printersCount > 0 && this.connect_to == 1) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for(let printer of this.printers) {
                let printerItem = PopupIconMenuItem('emblem-documents-symbolic', printer);
                if(printer == p_default) printerItem.setOrnament(PopupMenu.Ornament.CHECK);
                printerItem.printer = printer;
                printerItem.connect('activate', this.onShowJobsClicked.bind(this));
                this.menu.addMenuItem(printerItem);
            }
        }
        //Jobs, in the order CUPS will print them: the printing one, then highest priority, then oldest
        let printing = job => job['job-state'][0] == 5 ? 1 : 0; // processing
        p_jobs.sort((a, b) => printing(b) - printing(a) || b['job-priority'][0] - a['job-priority'][0] || a['job-id'][0] - b['job-id'][0]);
        this.jobsCount = p_jobs.length;
        //Cancel all Jobs
        if(this.jobsCount > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            let cancelAll = PopupIconMenuItem('edit-delete-symbolic', _('Cancel all jobs'));
            cancelAll.connect('activate', this.onCancelAllJobsClicked.bind(this));
            this.menu.addMenuItem(cancelAll);
        }
        //Add Jobs, grouped by printer (a Map keeps the sort order within each printer)
        let printerJobs = new Map();
        for(let p_job of p_jobs) {
            let printer = p_job['job-printer-uri'][0].split('/').pop();
            if(!printerJobs.has(printer)) printerJobs.set(printer, []);
            printerJobs.get(printer).push(p_job);
        }
        let sendJobs = new Map();
        for(let [printer, jobs] of printerJobs) {
            // A heading per printer replaces "at <printer>" on each job
            if(this.printersCount > 1) this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(printer));
            let waiting = 0; // jobs before this one that aren't printing yet
            jobs.forEach(p_job => {
                let job = p_job['job-id'][0].toString();
                let active = p_job['job-state'][0] == 5; // processing
                let doc = p_job['job-name'][0] ?? '';
                if(doc.length > 30) doc = doc.substring(0, 30) + '...';
                let text = doc;
                if(this.job_number) text += ' (' + job + ')';
                let jobItem = PopupIconMenuItem('edit-delete-symbolic', text);
                if(active) jobItem.setOrnament(PopupMenu.Ornament.CHECK);
                jobItem.job = job;
                jobItem.connect('activate', this.onCancelJobClicked.bind(jobItem));
                this.menu.addMenuItem(jobItem);
                // Per printer, as each printer has its own queue. The first waiting
                // job is already at the front (lpq calls it "1st", after "active").
                if(!active && waiting++ > 0 && this.send_to_front) {
                    let sendItem = PopupIconMenuItem('go-up-symbolic', text);
                    sendItem.job = job;
                    sendItem.connect('activate', this.onSendToFrontClicked.bind(sendItem));
                    if(!sendJobs.has(printer)) sendJobs.set(printer, []);
                    sendJobs.get(printer).push(sendItem);
                }
            });
        }
        //Send to Front: submenus can't be nested, so headings group the jobs by printer
        if(this.send_to_front && sendJobs.size > 0) {
            let subMenu = new PopupMenu.PopupSubMenuMenuItem(_('Send to front'));
            for(let [printer, items] of sendJobs) {
                if(sendJobs.size > 1) subMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(printer));
                for(let item of items) subMenu.menu.addMenuItem(item);
            }
            this.menu.addMenuItem(subMenu);
        }
        //Update Icon
        if(this.jobsCount > 0 && this.show_jobs) this._jobs.text = this.jobsCount.toString();
        else this._jobs.text = '';
        if(this.show_icon == 0 || (this.show_icon == 1 && this.printersCount > 0) || (this.show_icon == 2 && this.jobsCount > 0)) {
            this.show();
            this.printError = p_problems.some(({reason}) => isErrorReason(reason));
            this.printWarning = p_problems.length > 0;
            this.updateIcon();
        }
        else this.hide();
    }

    // Triggers only mark the menu as out of date; runRefresh() decides
    // when to refresh: not while the menu is open or a refresh is running.
    queueRefresh() {
        this._refreshNeeded = true;
        this.runRefresh();
    }
    async runRefresh() {
        if(this._destroyed || this.menuIsOpen || this.updating || !this._refreshNeeded) return;
        this._refreshNeeded = false;
        await this.refresh();
        this.runRefresh(); // pick up changes made during the refresh
    }

    onSettingsChanged() {
        if(this._destroyed) return;
        this.queueRefresh();
    }
    // A print job sends dozens of signals. Refresh at most once a second:
    // the first signal starts the timer, the ones until it fires share it.
    // (The timer isn't restarted by each signal, so a long stream of signals
    // still refreshes every second.)
    onCupsSignal() {
        if(this._destroyed) return;
        if(!this._signalTimeout) this._signalTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._signalTimeout = 0;
            this.queueRefresh();
            return GLib.SOURCE_REMOVE;
        });
    }
});

let printersManager;

export default class Printers extends Extension {

    enable() {
        printersManager = new PrintersManager(this.getSettings());
        try {
            Main.panel.addToStatusArea('printers', printersManager);
        } catch (e) {
            printersManager.destroy();
            printersManager = null;
            throw e;
        }
    }

    disable() {
        printersManager.destroy();
        printersManager = null;
    }

}
