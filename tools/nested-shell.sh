#!/bin/bash
# Run the repo's working files in a nested GNOME Shell as printers-dev@linux-man.org.
# The extension is copied (not symlinked) under an unpublished UUID, so the
# extension updater can never overwrite the repo, and it can run alongside an
# installed copy of the extension. The nested shell uses its own dconf
# database, with only this extension enabled.
REPO=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
UUID=printers-dev@linux-man.org
DEST=~/.local/share/gnome-shell/extensions/$UUID
LOG=/tmp/printers-nested.log
export XDG_CONFIG_HOME=~/.cache/printers-nested/config

install_dev() {
    rm -rf "$DEST"
    mkdir -p "$(dirname "$DEST")"
    cp -r "$REPO/printers@linux-man.org" "$DEST"
    sed -i "s/\"uuid\": \"printers@linux-man.org\"/\"uuid\": \"$UUID\"/" "$DEST/metadata.json"
    glib-compile-schemas "$DEST/schemas/"
}
export -f install_dev
export REPO UUID DEST LOG

install_dev

exec dbus-run-session -- bash --rcfile <(cat ~/.bashrc; cat <<'EOF'
gsettings set org.gnome.shell allow-extension-installation true
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
start_nested() {
    gnome-shell --nested --wayland --mode=user > "$LOG" 2>&1 &
    # Let D-Bus-activated apps (prefs, terminals) open in the nested shell
    sleep 3; dbus-update-activation-environment WAYLAND_DISPLAY=$(ls -t /run/user/$UID/ | grep -m1 -E '^wayland-[0-9]+$')
}
reload() { kill %1 2>/dev/null; wait 2>/dev/null; install_dev; start_nested; }
start_nested
PS1="(nested) $PS1"
trap 'rm -rf "$DEST"' EXIT
echo "Nested shell started with $UUID; log in $LOG."
echo "'reload' copies your edits and restarts it; 'exit' removes the copy."
EOF
)
