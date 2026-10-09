#!/bin/bash
# push the working copy's page files to the ISSUE test relay (bind-mounted single files; no restart needed)
cd "$(dirname "$0")/../../web/public" && scp -q index.html boot.js tips.json raid:/srv/cs-party/test4084/public/ && echo synced
