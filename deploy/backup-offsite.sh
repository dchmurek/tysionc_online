#!/bin/sh
# Kopia poza serwer (np. cron codziennie o 4:00): kopiuje najnowsze paczki backups/ na inny dysk/serwer.
# Przykład crontab:  0 4 * * * /opt/tysiac/deploy/backup-offsite.sh user@inny-serwer:/kopie/tysiac/
set -eu
DEST="${1:?Podaj cel rsync, np. user@host:/kopie/tysiac/}"
rsync -a --chmod=F600 /var/lib/tysiac/backups/ "$DEST"
