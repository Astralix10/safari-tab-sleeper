tell application "Safari"
	if it is not running then error "Safari не запущен."
	if (count of windows) is 0 then error "В Safari нет окон."
	set targetTab to current tab of front window
	set originalURL to URL of targetTab
	set URL of targetTab to originalURL
	return "Перезагружено: " & originalURL
end tell
