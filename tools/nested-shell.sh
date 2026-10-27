#!/bin/bash
# Run the repo's working files in a nested GNOME Shell as printers-dev@linux-man.org.
# The extension is copied (not symlinked) under an unpublished UUID, so the
# extension updater can never overwrite the repo, and it can run alongside an
# installed copy of the extension. The nested shell uses its own dconf
# database, with only this extension enabled.
REPO=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
UUID=printers-dev@linux-man.org
DEST=~/.local/share/gnome-shell/extensions/$UUID
GNOME_SHELL_LOG=/tmp/printers-nested-gnome-shell.log
DBUS_LOG=/tmp/printers-nested-dbus.log
export XDG_CONFIG_HOME=~/.cache/printers-nested/config

install_dev() {
    rm -rf "$DEST"
    mkdir -p "$(dirname "$DEST")"
    cp -r "$REPO/printers@linux-man.org" "$DEST"
    sed -i "s/\"uuid\": \"printers@linux-man.org\"/\"uuid\": \"$UUID\"/" "$DEST/metadata.json"
    glib-compile-schemas "$DEST/schemas/"
}
export -f install_dev
export REPO UUID DEST GNOME_SHELL_LOG DBUS_LOG

install_dev

# The D-Bus daemon and the services it starts log to $DBUS_LOG; the
# interactive shell gets the terminal's stdout and stderr back from fds 4 and 3.
# -i is needed because bash isn't interactive (and ignores --rcfile) when
# stderr isn't a tty.
echo "Starting private D-Bus session..."
exec 3>&2 4>&1
exec dbus-run-session -- bash --rcfile <(echo 'exec 1>&4 2>&3 3>&- 4>&-'; cat ~/.bashrc; cat <<'EOF'
gsettings set org.gnome.shell allow-extension-installation true
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
start_nested() {
    gnome-shell --nested --wayland --mode=user > "$GNOME_SHELL_LOG" 2>&1 &
    # Let D-Bus-activated apps (prefs, terminals) open in the nested shell
    sleep 3; dbus-update-activation-environment WAYLAND_DISPLAY=$(ls -t /run/user/$UID/ | grep -m1 -E '^wayland-[0-9]+$')
}
reload() { kill %1 2>/dev/null; wait 2>/dev/null; install_dev; start_nested; }
echo "Starting nested GNOME Shell with $UUID..."
start_nested
PS1="(nested) $PS1"
trap 'rm -rf "$DEST"; echo "Removed $DEST; stopping D-Bus session."' EXIT
echo
echo "Nested GNOME Shell started with $UUID."
echo "GNOME Shell log (extension errors, console.log): $GNOME_SHELL_LOG"
echo "  view it with: tail -f $GNOME_SHELL_LOG"
echo "D-Bus log: $DBUS_LOG"
echo
echo "'reload' copies your edits and restarts the nested shell."
echo "'exit' stops it and removes the copy."
EOF
) -i >>"$DBUS_LOG" 2>&1
