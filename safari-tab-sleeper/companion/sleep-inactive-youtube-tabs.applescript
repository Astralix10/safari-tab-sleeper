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
		set rawText to read POSIX file allowlistPath as «class utf8»
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
	if lowerURL starts with "http://127.0.0.1:17654/sleep" then return true
	if lowerURL starts with "safari-web-extension:" and lowerURL contains "/sleep/sleep.html" then return true
	if lowerURL starts with "safari-extension:" and lowerURL contains "/sleep/sleep.html" then return true
	if lowerURL starts with "chrome-extension:" and lowerURL contains "/sleep/sleep.html" then return true
	return false
end isLocalSleeperURL

on isPressureURL(tabURL)
	set lowerURL to my lowerText(tabURL)
	set pressureDomains to {"youtube.com", "youtu.be", "twitch.tv", "netflix.com", "meet.google.com", "figma.com", "canva.com", "reddit.com", "x.com", "twitter.com"}
	repeat with pressureDomain in pressureDomains
		if lowerURL contains (pressureDomain as text) then return true
	end repeat
	return false
end isPressureURL

on run argv
	if (count of argv) is 0 then error "Не передан путь к local-sleeper.html."
	set sleeperPath to item 1 of argv
	set allowlistPath to ""
	if (count of argv) is greater than 1 then set allowlistPath to item 2 of argv
	set sleptCount to 0
	
	tell application "Safari"
		if it is not running then return "slept_count=0 safari_not_running=1"
		repeat with wi from 1 to count of windows
			set targetWindow to window wi
			try
				set activeTabIndex to index of current tab of targetWindow
			on error
				set activeTabIndex to 0
			end try
			
			repeat with ti from 1 to count of tabs of targetWindow
				if ti is not activeTabIndex then
					set targetTab to tab ti of targetWindow
					set originalURL to URL of targetTab
					if (not my isLocalSleeperURL(originalURL)) and (not my isAllowlistedURL(originalURL, allowlistPath)) and my isPressureURL(originalURL) then
						try
							set originalTitle to name of targetTab
						on error
							set originalTitle to originalURL
						end try
						set sleeperURL to (my fileURLFromPath(sleeperPath)) & "#url=" & (my encodeQueryComponent(originalURL)) & "&title=" & (my encodeQueryComponent(originalTitle)) & "&reason=memory&auto=1"
						set URL of targetTab to sleeperURL
						set sleptCount to sleptCount + 1
					end if
				end if
			end repeat
		end repeat
	end tell
	
	return "slept_count=" & sleptCount
end run
