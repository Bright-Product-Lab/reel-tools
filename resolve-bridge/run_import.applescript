-- Clicks Workspace > Scripts > Reel Bin Import in DaVinci Resolve (works on the free edition).
-- Waits up to 10 minutes for Resolve to finish launching and for a project to be open.
on run argv
	set bundleId to item 1 of argv
	repeat 200 times
		try
			tell application "System Events"
				set procs to (every process whose bundle identifier is bundleId)
				if (count of procs) > 0 then
					set p to item 1 of procs
					tell p
						set frontmost to true
						set ws to menu bar item "Workspace" of menu bar 1
						set scriptsMenu to menu 1 of menu item "Scripts" of menu 1 of ws
						if exists menu item "Reel Bin Import" of scriptsMenu then
							click menu item "Reel Bin Import" of scriptsMenu
							return "ok"
						end if
						repeat with sub in (menu items of scriptsMenu)
							try
								if exists menu item "Reel Bin Import" of menu 1 of sub then
									click menu item "Reel Bin Import" of menu 1 of sub
									return "ok"
								end if
							end try
						end repeat
					end tell
				end if
			end tell
		on error errMsg number errNum
			if errNum is -1719 or errNum is -25211 then return "noaccess"
		end try
		delay 3
	end repeat
	return "timeout"
end run
