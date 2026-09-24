; Included by electron-builder's NSIS installer (package.json → build.nsis.include).

; "Launch at login" is a registry value that the app writes at runtime (Electron names it after the
; AppUserModelId, which equals appId). Remove it on a real uninstall so no dead startup entry stays
; behind — but not when the old version is uninstalled as part of an update.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endIf}
!macroend
