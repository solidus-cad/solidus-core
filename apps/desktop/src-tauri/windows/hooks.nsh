; NSIS installer hooks (included by Tauri's installer.nsi template).
;
; cad.config.toml is not a resource tracked by the installer: uninstallation (including the one run before
; an update) removes files one by one and therefore does not touch it. It is created only once, from the
; cad.config.default.toml template (which is replaced in every version).
;
; Explorer thumbnails of the .vpart / .vasm files: solidus_thumbnail.dll (apps/desktop/thumbnail-win), a COM
; server registered for the current user (installMode currentUser: HKCU\Software\Classes). Explorer may keep the
; DLL loaded (dllhost.exe): before an update or an uninstallation it is renamed, which Windows allows for a loaded
; DLL, and the renamed copy is deleted at the next installation. The installer is a 32-bit program: the registry is
; written in its 64-bit view (as Tauri's SetContext already does for an x64 build), otherwise Windows redirects
; HKCU\Software\Classes\CLSID to Wow6432Node, where the 64-bit Explorer does not look.

!define SOLIDUS_THUMB_CLSID "{2d4edcf3-9d60-4b39-930d-a0afb5d77707}"
!define SOLIDUS_THUMB_SHELLEX "ShellEx\{e357fccd-a995-4576-b01f-234630154e96}"

; File associations (bundle.fileAssociations of tauri.conf.json): Tauri's APP_ASSOCIATE writes .vpart → Solidus.Part
; (icon = the exe's, open = `cad-desktop.exe "%1"`) and keeps the previous class in a `Solidus.Part_backup` value,
; which APP_UNASSOCIATE puts back but never deletes. After an actual uninstallation, the extension key is left
; empty when nothing was associated before, and then removed.
!macro SOLIDUS_ASSOC_CLEAN EXT CLASS
  ReadRegStr $R0 HKCU "Software\Classes\.${EXT}" "${CLASS}_backup"
  ${If} $R0 == ""
    DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.${EXT}" "${CLASS}_backup"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\ShellEx"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
!macroend

!macro SOLIDUS_THUMB_MOVE_ASIDE
  Delete "$INSTDIR\solidus_thumbnail.dll.old"
  ${If} ${FileExists} "$INSTDIR\solidus_thumbnail.dll"
    Delete "$INSTDIR\solidus_thumbnail.dll"
    ${If} ${FileExists} "$INSTDIR\solidus_thumbnail.dll"
      Rename "$INSTDIR\solidus_thumbnail.dll" "$INSTDIR\solidus_thumbnail.dll.old"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SOLIDUS_THUMB_MOVE_ASIDE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${IfNot} ${FileExists} "$INSTDIR\cad.config.toml"
    CopyFiles /SILENT "$INSTDIR\cad.config.default.toml" "$INSTDIR\cad.config.toml"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\solidus_thumbnail.dll"
    SetRegView 64
    WriteRegStr HKCU "Software\Classes\CLSID\${SOLIDUS_THUMB_CLSID}" "" "Solidus thumbnails"
    WriteRegStr HKCU "Software\Classes\CLSID\${SOLIDUS_THUMB_CLSID}\InprocServer32" "" "$INSTDIR\solidus_thumbnail.dll"
    WriteRegStr HKCU "Software\Classes\CLSID\${SOLIDUS_THUMB_CLSID}\InprocServer32" "ThreadingModel" "Apartment"
    WriteRegStr HKCU "Software\Classes\.vpart\${SOLIDUS_THUMB_SHELLEX}" "" "${SOLIDUS_THUMB_CLSID}"
    WriteRegStr HKCU "Software\Classes\.vasm\${SOLIDUS_THUMB_SHELLEX}" "" "${SOLIDUS_THUMB_CLSID}"
    SetRegView lastused
  ${EndIf}
  ; Explorer reads the associations and the thumbnail handler again (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SOLIDUS_THUMB_MOVE_ASIDE
!macroend

; Actual uninstallation with "Delete the application data" checked: also removes the settings.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    SetRegView 64
    DeleteRegKey HKCU "Software\Classes\CLSID\${SOLIDUS_THUMB_CLSID}"
    DeleteRegKey HKCU "Software\Classes\.vpart\${SOLIDUS_THUMB_SHELLEX}"
    DeleteRegKey HKCU "Software\Classes\.vasm\${SOLIDUS_THUMB_SHELLEX}"
    !insertmacro SOLIDUS_ASSOC_CLEAN "vpart" "Solidus.Part"
    !insertmacro SOLIDUS_ASSOC_CLEAN "vasm" "Solidus.Assembly"
    !insertmacro SOLIDUS_ASSOC_CLEAN "vdrw" "Solidus.Drawing"
    SetRegView lastused
    Delete /REBOOTOK "$INSTDIR\solidus_thumbnail.dll.old"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    Delete "$INSTDIR\cad.config.toml"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
