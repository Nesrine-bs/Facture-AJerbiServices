@echo off
cd /d "%~dp0"
start "Factures A Jerbi Services" http://localhost:8765
py -m http.server 8765
