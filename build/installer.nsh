; Append the install directory to the per-user PATH so `mousse-cli` resolves.
; Existing terminals must be reopened after install to pick up the change.
;
; Do not !define WM_SETTINGCHANGE here — electron-builder includes this file
; before MUI2/WinMessages.nsh, and redefining that symbol aborts makensis.

!macro customInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ; $0 empty → write install dir only
  StrCmp $0 "" 0 +3
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    Goto mousse_path_broadcast
  ; Already contains install dir? (substring check)
  Push "$0"
  Push "$INSTDIR"
  Call MousseStrContains
  Pop $1
  StrCmp $1 "" 0 mousse_path_broadcast
  WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
mousse_path_broadcast:
  ; WM_SETTINGCHANGE = 0x001A (same as WM_WININICHANGE)
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, i 0, t "Environment", i 0, i 5000, *i .r0)'
!macroend

!macro customUnInstall
  ; Best-effort PATH cleanup is skipped: removing arbitrary PATH segments from NSIS
  ; without a full tokenizer is error-prone. Leaving $INSTDIR on PATH is harmless.
!macroend

; Only compiled for the installer (not BUILD_UNINSTALLER). Unreferenced
; install-time functions fail the uninstaller build when warnings are errors.
!ifndef BUILD_UNINSTALLER
; Stack: haystack, needle → result (needle if found, else "")
Function MousseStrContains
  Exch $R1 ; needle
  Exch
  Exch $R2 ; haystack
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R4 0
mousse_sc_loop:
  StrCpy $R5 $R2 $R3 $R4
  StrCmp $R5 "" mousse_sc_no
  StrCmp $R5 $R1 mousse_sc_yes
  IntOp $R4 $R4 + 1
  Goto mousse_sc_loop
mousse_sc_yes:
  StrCpy $R0 $R1
  Goto mousse_sc_done
mousse_sc_no:
  StrCpy $R0 ""
mousse_sc_done:
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd
!endif
