#!/bin/sh
set -eu

# PHP's Apache module requires prefork. Normalize enabled modules at container startup too,
# so the platform image unpacking/startup cannot leave a second MPM enabled.
if [ "${1:-}" = 'apache2-foreground' ]; then
    a2dismod -f mpm_event mpm_worker >/dev/null 2>&1 || true
    a2enmod mpm_prefork >/dev/null
fi

exec docker-entrypoint.sh "$@"
