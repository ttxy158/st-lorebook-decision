#!/usr/bin/env bash
# Turn on enableCorsProxy in SillyTavern's config.yaml.
# The decision endpoint sends a non-standard request body, so the browser cannot reach it
# directly and the plugin borrows SillyTavern's own /proxy route - which is off by default.
#
# Usage:
#   bash enable-cors-proxy.sh                 # locate config.yaml by walking up from this file
#   bash enable-cors-proxy.sh /path/to/SillyTavern
#   bash enable-cors-proxy.sh /path/to/config.yaml

set -u

find_config() {
    local dir="$1" steps=0
    while [ "$steps" -lt 12 ] && [ -n "$dir" ] && [ "$dir" != "/" ]; do
        if [ -f "$dir/config.yaml" ] && [ -f "$dir/server.js" ]; then
            printf '%s\n' "$dir/config.yaml"
            return 0
        fi
        dir="$(dirname "$dir")"
        steps=$((steps + 1))
    done
    return 1
}

TARGET=""
if [ "$#" -gt 0 ]; then
    if [ -d "$1" ]; then
        TARGET="$(find_config "$1" || true)"
        [ -z "$TARGET" ] && [ -f "$1/config.yaml" ] && TARGET="$1/config.yaml"
    elif [ -f "$1" ]; then
        TARGET="$1"
    fi
fi

if [ -z "$TARGET" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
    TARGET="$(find_config "$SCRIPT_DIR" || true)"
fi

if [ -z "$TARGET" ]; then
    echo "Cannot find SillyTavern's config.yaml."
    echo "Pass the path yourself:  bash $0 /path/to/SillyTavern"
    exit 1
fi

echo "Config file: $TARGET"

if [ ! -w "$TARGET" ]; then
    echo "Cannot write to it (permission denied)."
    exit 1
fi

if grep -Eq '^[[:space:]]*enableCorsProxy[[:space:]]*:[[:space:]]*true[[:space:]]*(#.*)?$' "$TARGET"; then
    echo "enableCorsProxy is already true. Nothing to change."
    echo "If the plugin still reports 403, restart SillyTavern - the config is read once at startup."
    exit 0
fi

cp -p "$TARGET" "$TARGET.bak" && echo "Backup written: $TARGET.bak"

awk '
    /^[[:space:]]*enableCorsProxy[[:space:]]*:/ {
        if (!seen) { print "enableCorsProxy: true"; seen = 1 }
        next
    }
    { print }
    END { if (!seen) print "enableCorsProxy: true" }
' "$TARGET" > "$TARGET.tmp" || { rm -f "$TARGET.tmp"; echo "Rewrite failed."; exit 1; }

mv "$TARGET.tmp" "$TARGET"

if grep -Eq '^enableCorsProxy[[:space:]]*:[[:space:]]*true$' "$TARGET"; then
    echo "Done. enableCorsProxy is now true."
    echo "Restart SillyTavern for it to take effect."
else
    echo "Rewritten, but the check did not pass. Open the file and look at the enableCorsProxy line."
    exit 1
fi
