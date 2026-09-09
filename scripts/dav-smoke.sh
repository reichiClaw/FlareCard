#!/usr/bin/env bash
# Exercises the FlareCard CardDAV endpoints with curl, the way iOS/macOS and DAVx5 do.
#
# Usage:
#   BASE=http://127.0.0.1:47321 USER=admin PASS=flarecard-dev-admin scripts/dav-smoke.sh
#
# Set SEED=1 to load the demo contacts first (requires an admin user).
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:47321}"
USER="${USER_NAME:-${USER:-admin}}"
PASS="${PASS:-flarecard-dev-admin}"
AUTH=(-u "$USER:$PASS")
XML=(-H "Content-Type: application/xml; charset=utf-8")

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
req() { curl -sS "${AUTH[@]}" "$@"; }

bold "OPTIONS (capabilities)"
curl -sS -i -X OPTIONS "$BASE/dav/" | sed -n '1p;/^DAV:/Ip;/^Allow:/Ip'

bold "/.well-known/carddav redirect"
curl -sS -o /dev/null -w "HTTP %{http_code} -> %{redirect_url}\n" "$BASE/.well-known/carddav"

bold "Unauthenticated PROPFIND must be 401 with a Basic challenge"
curl -sS -i -X PROPFIND -H "Depth: 0" "$BASE/dav/" | sed -n '1p;/^WWW-Authenticate:/Ip'

if [[ "${SEED:-0}" == "1" ]]; then
  bold "Seeding demo contacts (admin API)"
  req -X POST "$BASE/api/contacts/seed"; echo
fi

bold "PROPFIND root: current-user-principal"
req -X PROPFIND -H "Depth: 0" "${XML[@]}" --data-binary @- "$BASE/dav/" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/><D:resourcetype/></D:prop></D:propfind>
EOF
echo

bold "PROPFIND principal: addressbook-home-set, displayname"
req -X PROPFIND -H "Depth: 0" "${XML[@]}" --data-binary @- "$BASE/dav/principals/$USER/" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:principal-URL/><C:addressbook-home-set/><D:displayname/><D:current-user-privilege-set/></D:prop>
</D:propfind>
EOF
echo

bold "PROPFIND home (Depth 1): discover address books"
req -X PROPFIND -H "Depth: 1" "${XML[@]}" --data-binary @- "$BASE/dav/addressbooks/" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop><D:resourcetype/><D:displayname/><CS:getctag/><D:sync-token/><D:supported-report-set/><C:supported-address-data/></D:prop>
</D:propfind>
EOF
echo

bold "PROPFIND address book (Depth 1): getetag for every .vcf"
req -X PROPFIND -H "Depth: 1" "${XML[@]}" --data-binary @- "$BASE/dav/addressbooks/shared/" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getcontenttype/></D:prop></D:propfind>
EOF
echo

FIRST_HREF=$(req -X PROPFIND -H "Depth: 1" "${XML[@]}" \
  --data-binary '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>' \
  "$BASE/dav/addressbooks/shared/" | grep -o '/dav/addressbooks/shared/[^<]*\.vcf' | head -1 || true)

if [[ -n "$FIRST_HREF" ]]; then
  bold "GET $FIRST_HREF"
  curl -sS -i "${AUTH[@]}" "$BASE$FIRST_HREF" | sed -n '1p;/^ETag:/Ip;/^Content-Type:/Ip'
  echo "..."
  req "$BASE$FIRST_HREF" | head -8

  bold "REPORT addressbook-multiget"
  req -X REPORT -H "Depth: 1" "${XML[@]}" --data-binary @- "$BASE/dav/addressbooks/shared/" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>
  <D:href>$FIRST_HREF</D:href>
  <D:href>/dav/addressbooks/shared/does-not-exist.vcf</D:href>
</C:addressbook-multiget>
EOF
  echo

  bold "PUT must be rejected with 403 (read-only)"
  curl -sS -o /dev/null -w "HTTP %{http_code}\n" "${AUTH[@]}" -X PUT -H "Content-Type: text/vcard" \
    --data-binary $'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Mallory\r\nEND:VCARD\r\n' "$BASE$FIRST_HREF"
  bold "DELETE must be rejected with 403 (read-only)"
  curl -sS -o /dev/null -w "HTTP %{http_code}\n" "${AUTH[@]}" -X DELETE "$BASE$FIRST_HREF"
else
  echo "(no contacts yet — run with SEED=1 or add contacts in the admin UI)"
fi

bold "REPORT addressbook-query: FN contains 'a'"
req -X REPORT -H "Depth: 1" "${XML[@]}" --data-binary @- "$BASE/dav/addressbooks/shared/" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/></D:prop>
  <C:filter><C:prop-filter name="FN"><C:text-match collation="i;unicode-casemap" match-type="contains">a</C:text-match></C:prop-filter></C:filter>
</C:addressbook-query>
EOF
echo

bold "REPORT sync-collection: initial sync (empty token)"
SYNC=$(req -X REPORT -H "Depth: 0" "${XML[@]}" --data-binary @- "$BASE/dav/addressbooks/shared/" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token/><D:sync-level>1</D:sync-level>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>
EOF
)
echo "$SYNC"
TOKEN=$(echo "$SYNC" | grep -o '<D:sync-token>[^<]*</D:sync-token>' | tail -1 | sed 's/<[^>]*>//g')
echo
echo "sync-token: $TOKEN"

bold "REPORT sync-collection: incremental (should be empty)"
req -X REPORT -H "Depth: 0" "${XML[@]}" --data-binary @- "$BASE/dav/addressbooks/shared/" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>$TOKEN</D:sync-token><D:sync-level>1</D:sync-level>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>
EOF
echo

bold "REPORT sync-collection: unknown token must be 507"
curl -sS -o /dev/null -w "HTTP %{http_code}\n" "${AUTH[@]}" -X REPORT -H "Depth: 0" "${XML[@]}" \
  --data-binary '<D:sync-collection xmlns:D="DAV:"><D:sync-token>urn:x-flarecard:sync:999999</D:sync-token><D:prop><D:getetag/></D:prop></D:sync-collection>' \
  "$BASE/dav/addressbooks/shared/"

printf '\nDone.\n'
