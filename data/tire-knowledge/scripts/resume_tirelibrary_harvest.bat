@echo off
REM Resume the Tirelibrary barcode harvest from its last checkpoint.
REM Safe to run anytime: it picks up from outputs\tirelibrary_progress.json.
cd /d C:\Users\djsan\inventory\data\tire-knowledge
"C:\Users\djsan\.local\bin\uv.exe" run python scripts\tirelibrary_api_harvest.py >> outputs\tirelibrary_harvest.log 2>&1
