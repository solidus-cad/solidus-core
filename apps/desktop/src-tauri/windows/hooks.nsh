; NSIS installer hooks (included by Tauri's installer.nsi template).
;
; cad.config.toml is not a resource tracked by the installer: uninstallation (including the one run before
; an update) removes files one by one and therefore does not touch it. It is created only once, from the
; cad.config.default.toml template (which is replaced in every version).

!macro NSIS_HOOK_POSTINSTALL
  ${IfNot} ${FileExists} "$INSTDIR\cad.config.toml"
    CopyFiles /SILENT "$INSTDIR\cad.config.default.toml" "$INSTDIR\cad.config.toml"
  ${EndIf}
!macroend

; Actual uninstallation with "Delete the application data" checked: also removes the settings.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    Delete "$INSTDIR\cad.config.toml"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
