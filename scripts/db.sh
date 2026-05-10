#!/usr/bin/env bash
# CardIQ database management — one-stop wrapper for Supabase CLI.
#
# Usage:
#   ./scripts/db.sh link                  → one-time: link this repo to your Supabase project
#   ./scripts/db.sh push                  → apply any new migrations to remote
#   ./scripts/db.sh status                → show which migrations are/aren't applied
#   ./scripts/db.sh new <name>            → scaffold a new migration file
#   ./scripts/db.sh pull                  → pull schema changes made via dashboard back into a migration
#   ./scripts/db.sh reset                 → DANGER: wipe + re-apply all migrations (LOCAL DB ONLY)
#
# Long-term workflow:
#   1. Edit/add SQL in supabase/migrations/
#   2. Run `./scripts/db.sh push`
#   3. Done.

set -euo pipefail

PROJECT_REF="dmmhtzwxqkduxvxipfqs"

cmd="${1:-help}"
shift || true

case "$cmd" in
  link)
    echo "🔗 Linking to project $PROJECT_REF…"
    echo "   You'll be asked for your DB password (the one you set when creating the Supabase project)."
    echo "   Find it at: https://supabase.com/dashboard/project/$PROJECT_REF/settings/database"
    supabase link --project-ref "$PROJECT_REF"
    ;;
  push)
    echo "⬆️  Pushing migrations to remote…"
    supabase db push
    ;;
  status)
    echo "📊 Migration status:"
    supabase migration list
    ;;
  new)
    name="${1:-}"
    if [[ -z "$name" ]]; then echo "Usage: ./scripts/db.sh new <migration_name>"; exit 1; fi
    supabase migration new "$name"
    ;;
  pull)
    supabase db pull
    ;;
  reset)
    echo "⚠️  This will wipe your LOCAL Supabase DB and re-apply all migrations."
    read -p "Continue? (y/N) " confirm
    [[ "$confirm" == "y" ]] && supabase db reset
    ;;
  help|*)
    head -20 "$0" | tail -15
    ;;
esac
