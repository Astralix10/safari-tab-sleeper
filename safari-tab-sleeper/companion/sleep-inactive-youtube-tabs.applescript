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

on isLocalSleeperURL(tabURL)
	set lowerURL to my lowerText(tabURL)
	if lowerURL starts with "file:" and lowerURL contains "local-sleeper.html" then return true
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
					if (not my isLocalSleeperURL(originalURL)) and my isPressureURL(originalURL) then
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
