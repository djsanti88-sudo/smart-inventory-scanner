@echo off
cd /d C:\Users\djsan\inventory\data\tire-knowledge
"C:\Users\djsan\.local\bin\uv.exe" run python scripts\upcitemdb_api_harvest.py >> outputs\api_daily.log 2>&1

