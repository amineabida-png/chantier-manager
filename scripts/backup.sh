#!/usr/bin/env bash
# Exporte un dump complet de la base PostgreSQL de CHANTIER MANAGER.
#
# Usage :
#   DATABASE_URL="postgresql://..." ./scripts/backup.sh [dossier_de_sortie]
#
# En local avec la CLI Railway (projet/service déjà liés) :
#   railway run ./scripts/backup.sh
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Erreur : la variable DATABASE_URL n'est pas définie." >&2
  echo "Exemple : DATABASE_URL=\"postgresql://...\" ./scripts/backup.sh" >&2
  exit 1
fi

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/chantier-manager-$TIMESTAMP.dump"

echo "Sauvegarde en cours vers $OUT_FILE ..."
pg_dump "$DATABASE_URL" --format=custom --file="$OUT_FILE"
echo "Terminé : $OUT_FILE"
echo
echo "Pour restaurer :"
echo "  pg_restore --clean --if-exists --no-owner --dbname=\"\$DATABASE_URL\" \"$OUT_FILE\""
