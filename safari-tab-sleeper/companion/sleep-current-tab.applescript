use framework "Foundation"
use scripting additions

on encodeQueryComponent(theText)
	set textObject to current application's |NSString|'s stringWithString:(theText as text)
	set allowed to current application's |NSCharacterSet|'s URLQueryAllowedCharacterSet()'s mutableCopy()
	allowed's removeCharactersInString:"&=+#?"
	set encoded to textObject's stringByAddingPercentEncodingWithAllowedCharacters:allowed
	return encoded as text
end encodeQueryComponent

on fileURLFromPath(posixPath)
	set fileURLObject to current application's |NSURL|'s fileURLWithPath:(posixPath as text)
	return fileURLObject's absoluteString() as text
end fileURLFromPath

on run argv
	if (count of argv) is 0 then error "Не передан путь к local-sleeper.html."
	set sleeperPath to item 1 of argv
	
	tell application "Safari"
		if it is not running then error "Safari не запущен."
		if (count of windows) is 0 then error "В Safari нет окон."
		set targetTab to current tab of front window
		set originalURL to URL of targetTab
		try
			set originalTitle to name of targetTab
		on error
			set originalTitle to originalURL
		end try
	end tell
	
set sleeperURL to (my fileURLFromPath(sleeperPath)) & "#url=" & (my encodeQueryComponent(originalURL)) & "&title=" & (my encodeQueryComponent(originalTitle)) & "&reason=manual"
	
	tell application "Safari"
		set URL of current tab of front window to sleeperURL
	end tell
	
	return "Усыплено: " & originalURL
end run
