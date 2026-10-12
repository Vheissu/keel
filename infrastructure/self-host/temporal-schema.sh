#!/bin/sh
set -eu
export SQL_PASSWORD=$(cat /run/secrets/temporal_password)
for database in temporal temporal_visibility; do
  if [ "$database" = temporal ]; then
    schema=temporal
  else
    schema=visibility
  fi
  temporal-sql-tool --plugin postgres12 --ep postgres -p 5432 -u temporal --db "$database" setup-schema -v 0.0
  temporal-sql-tool --plugin postgres12 --ep postgres -p 5432 -u temporal --db "$database" update-schema -d "/etc/temporal/schema/postgresql/v12/$schema/versioned"
done
