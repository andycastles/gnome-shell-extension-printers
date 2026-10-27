// Print the printers, default printer and jobs the extension would read from
// CUPS over IPP (printers@linux-man.org/ipp.js), and how long it took.
// Run with: npm run ipp-query
import GLib from 'gi://GLib';
import {CupsClient, PrinterState, JobState} from '../printers@linux-man.org/ipp.js';

const first = (attributes, name) => attributes[name]?.[0];

async function main() {
    const client = new CupsClient();
    try {
        const start = GLib.get_monotonic_time();
        const [printers, defaultPrinter, jobs] = await Promise.all([
            client.getPrinters(),
            client.getDefaultPrinter(),
            client.getJobs(),
        ]);
        const ms = (GLib.get_monotonic_time() - start) / 1000;

        print(`Printers (default: ${defaultPrinter ?? 'none'}):`);
        for (const p of printers) {
            const uri = first(p, 'device-uri');
            print(`  ${first(p, 'printer-name')}`);
            print(`    state: ${PrinterState[first(p, 'printer-state')]}, reasons: ${p['printer-state-reasons'].join(',')}`);
            print(`    accepting jobs: ${first(p, 'printer-is-accepting-jobs')}, message: "${first(p, 'printer-state-message') ?? ''}"`);
            print(`    device: ${uri} (${uri.startsWith('implicitclass:') ? 'implicitclass' : 'direct'})`);
        }

        // Rank = order CUPS will print in: highest priority first, then oldest
        jobs.sort((a, b) => first(b, 'job-priority') - first(a, 'job-priority') ||
            first(a, 'job-id') - first(b, 'job-id'));
        print(`Jobs (${jobs.length}):`);
        for (const j of jobs) {
            const printer = first(j, 'job-printer-uri').split('/').pop();
            print(`  #${first(j, 'job-id')} "${first(j, 'job-name')}" on ${printer}: ` +
                `${JobState[first(j, 'job-state')]} (${j['job-state-reasons'].join(',')}), ` +
                `priority ${first(j, 'job-priority')}, owner ${first(j, 'job-originating-user-name')}`);
        }

        print(`3 IPP requests in ${ms.toFixed(1)} ms`);
    } finally {
        client.destroy();
    }
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    printerr(e);
}).finally(() => loop.quit());
loop.run();
