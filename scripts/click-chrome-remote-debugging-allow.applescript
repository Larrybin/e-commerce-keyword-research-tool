on textOf(el)
  tell application "System Events"
    set parts to {}
    try
      set end of parts to name of el as text
    end try
    try
      set end of parts to description of el as text
    end try
    return parts as text
  end tell
end textOf

on hasRemoteDebuggingPrompt(el)
  tell application "System Events"
    set valueText to my textOf(el)
    if valueText contains "远程调试" or valueText contains "remote debugging" or valueText contains "Remote debugging" then return true
    try
      repeat with child in UI elements of el
        if my hasRemoteDebuggingPrompt(child) then return true
      end repeat
    end try
  end tell
  return false
end hasRemoteDebuggingPrompt

on clickAllow(el)
  tell application "System Events"
    try
      if (role of el as text) is "AXButton" then
        set buttonText to my textOf(el)
        if buttonText contains "允许" or buttonText contains "Allow" then
          click el
          return true
        end if
      end if
    end try
    try
      repeat with child in UI elements of el
        if my clickAllow(child) then return true
      end repeat
    end try
  end tell
  return false
end clickAllow

repeat 35 times
  try
    tell application "Google Chrome" to activate
    tell application "System Events"
      tell process "Google Chrome"
        repeat with w in windows
          if my hasRemoteDebuggingPrompt(w) and my clickAllow(w) then return "clicked"
        end repeat
      end tell
    end tell
  end try
  delay 0.3
end repeat

return "not_found"
