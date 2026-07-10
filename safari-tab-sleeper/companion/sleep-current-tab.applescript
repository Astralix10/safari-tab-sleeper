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

on sleepPageBaseURL(sleeperTarget)
	set targetText to sleeperTarget as text
	set textObject to current application's |NSString|'s stringWithString:targetText
	set lowerTarget to textObject's lowercaseString() as text
	if lowerTarget starts with "http://" or lowerTarget starts with "https://" then return targetText
	return my fileURLFromPath(targetText)
end sleepPageBaseURL

on run argv
	if (count of argv) is 0 then error "Не передан URL sleep-страницы."
	set sleeperTarget to item 1 of argv
	
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
	
set sleeperURL to (my sleepPageBaseURL(sleeperTarget)) & "#url=" & (my encodeQueryComponent(originalURL)) & "&title=" & (my encodeQueryComponent(originalTitle)) & "&reason=manual-current-tab&auto=0"
	
	tell application "Safari"
		set URL of current tab of front window to sleeperURL
	end tell
	
	return "Усыплено: " & originalURL
end run
