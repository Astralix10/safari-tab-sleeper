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

on lowerText(theText)
	set textObject to current application's |NSString|'s stringWithString:(theText as text)
	return (textObject's lowercaseString()) as text
end lowerText

on trimText(theText)
	set textObject to current application's |NSString|'s stringWithString:(theText as text)
	set trimmedObject to textObject's stringByTrimmingCharactersInSet:(current application's |NSCharacterSet|'s whitespaceAndNewlineCharacterSet())
	return trimmedObject as text
end trimText

on hostFromURL(tabURL)
	try
		set urlObject to current application's |NSURL|'s URLWithString:(tabURL as text)
		if urlObject is missing value then return ""
		set hostObject to urlObject's |host|()
		if hostObject is missing value then return ""
		return my lowerText(hostObject as text)
	on error
		return ""
	end try
end hostFromURL

on loadAllowlist(allowlistPath)
	if allowlistPath is "" then return {}
	try
		set rawText to read (POSIX file allowlistPath) as text
		return paragraphs of rawText
	on error
		return {}
	end try
end loadAllowlist

on patternMatchesHost(patternText, hostText)
	set patternText to my trimText(my lowerText(patternText))
	if patternText is "" then return false
	if patternText starts with "#" then return false
	if patternText starts with "*." then
		if (length of patternText) is less than 3 then return false
		set suffixText to text 3 thru -1 of patternText
		if hostText is suffixText then return true
		if hostText ends with ("." & suffixText) then return true
		return false
	end if
	if hostText is patternText then return true
	return false
end patternMatchesHost

on isAllowlistedURL(tabURL, allowlistPath)
	set hostText to my hostFromURL(tabURL)
	if hostText is "" then return false
	set allowlistEntries to my loadAllowlist(allowlistPath)
	repeat with allowlistEntry in allowlistEntries
		if my patternMatchesHost((allowlistEntry as text), hostText) then return true
	end repeat
	return false
end isAllowlistedURL

on isLocalSleeperURL(tabURL)
	set lowerURL to my lowerText(tabURL)
	if lowerURL starts with "file:" and lowerURL contains "local-sleeper.html" then return true
	try
		set urlObject to current application's |NSURL|'s URLWithString:(tabURL as text)
		set hostText to my lowerText((urlObject's |host|()) as text)
		set pathText to (urlObject's |path|()) as text
		if (hostText is "127.0.0.1" or hostText is "localhost") and pathText is "/sleep" then return true
	end try
	if lowerURL starts with "safari-web-extension:" and lowerURL contains "/sleep/sleep.html" then return true
	if lowerURL starts with "safari-extension:" and lowerURL contains "/sleep/sleep.html" then return true
	return false
end isLocalSleeperURL

on run argv
	if (count of argv) is 0 then error "Не передан URL sleep-страницы."
	set sleeperTarget to item 1 of argv
	set allowlistPath to ""
	if (count of argv) is greater than 1 then set allowlistPath to item 2 of argv
	set entryToken to ""
	if (count of argv) is greater than 2 then set entryToken to item 3 of argv
	if entryToken is "" then error "Не передан токен сна."
	
	tell application "Safari"
		if it is not running then error "Safari не запущен."
		if (count of windows) is 0 then error "В Safari нет окон."
		set targetTab to current tab of front window
		set originalURL to URL of targetTab
		if my isLocalSleeperURL(originalURL) then return "slept_count=0 skipped_count=1 reason=already-sleeping"
		if my isAllowlistedURL(originalURL, allowlistPath) then return "slept_count=0 skipped_count=1 reason=allowlisted"
		try
			set originalTitle to name of targetTab
		on error
			set originalTitle to originalURL
		end try
	end tell
	
set sleeperURL to (my sleepPageBaseURL(sleeperTarget)) & "#token=" & (my encodeQueryComponent(entryToken))
	
	tell application "Safari"
		set URL of current tab of front window to sleeperURL
	end tell
	
	return "slept_count=1 url=" & originalURL
end run
