-- Reel Bin Bridge: handles reelbin:// links from the Reel Bin web app.
on open location theURL
	set bridgeScript to POSIX path of (path to me) & "Contents/Resources/bridge.sh"
	do shell script "/bin/bash " & quoted form of bridgeScript & " " & quoted form of theURL
end open location

on run
	display dialog "Reel Bin Bridge is installed." & return & return & "In Reel Bin, click Send to Resolve: the job lands here and DaVinci Resolve opens. Then choose Workspace › Scripts › Reel Bin Import." buttons {"OK"} default button 1 with title "Reel Bin Bridge"
end run
