; Append the install directory to the per-user PATH so `mousse-cli` resolves.
; Existing terminals must be reopened after install to pick up the change.
;
; Do not !define WM_SETTINGCHANGE here — electron-builder includes this file
; before MUI2/WinMessages.nsh, and redefining that symbol aborts makensis.

; The packaged MMS daemon is hosted by `Mousse.exe --cli service run`. Electron-
; builder's stock running-app check only looks at the executable path, so it
; otherwise reports that Mousse is open after the desktop window has closed.
;
; Ask that daemon to shut down gracefully before applying the normal check. If a
; desktop window really is open (or the daemon cannot stop), the stock check below
; still prompts the user and protects files that are in use.
; This must only be part of the outer installer. Compiling it into the generated
; uninstaller makes an upgrade deadlock: electron-builder launches the old
; uninstaller while the outer installer waits, and the old uninstaller launches
; Mousse again from the directory it is trying to remove.
!ifndef BUILD_UNINSTALLER
  !include "getProcessInfo.nsh"
  Var pid
  !macro customCheckAppRunning
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 mousse_check_app
      DetailPrint "Stopping the Mousse background service..."
      nsExec::Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cli --mode json service stop`
      Pop $0
  mousse_check_app:
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  !macroend
!endif

!macro customInstall
  ; mousse-cli.exe is Mousse.exe marked as a console program, so terminals wait for it and
  ; Node sees real TTY streams. It is made here from the installed Mousse.exe rather than
  ; shipped, so the Setup download carries the Electron runtime once.
  ; Same edit as scripts/windows-console-exe.mjs: the 16-bit Subsystem field, at
  ; e_lfanew + 92, becomes 3 (IMAGE_SUBSYSTEM_WINDOWS_CUI).
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Delete "$INSTDIR\mousse-cli.exe"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\mousse-cli.exe"
  IfErrors mousse_cli_failed
  FileOpen $R0 "$INSTDIR\mousse-cli.exe" a
  IfErrors mousse_cli_failed
  ; e_lfanew, a little-endian 32-bit offset at 0x3C.
  FileSeek $R0 60 SET
  FileReadByte $R0 $R1
  FileReadByte $R0 $R2
  FileReadByte $R0 $R3
  FileReadByte $R0 $R4
  IntOp $R2 $R2 << 8
  IntOp $R3 $R3 << 16
  IntOp $R4 $R4 << 24
  IntOp $R1 $R1 | $R2
  IntOp $R1 $R1 | $R3
  IntOp $R1 $R1 | $R4
  ; The PE signature "PE\0\0" must be there before anything is written.
  FileSeek $R0 $R1 SET
  FileReadByte $R0 $R2
  FileReadByte $R0 $R3
  IfErrors mousse_cli_bad_header
  StrCmp $R2 80 0 mousse_cli_bad_header
  StrCmp $R3 69 0 mousse_cli_bad_header
  IntOp $R1 $R1 + 92
  FileSeek $R0 $R1 SET
  FileWriteByte $R0 3
  FileWriteByte $R0 0
  FileClose $R0
  IfErrors mousse_cli_failed mousse_cli_done
mousse_cli_bad_header:
  FileClose $R0
  Delete "$INSTDIR\mousse-cli.exe"
mousse_cli_failed:
  DetailPrint "Could not create mousse-cli.exe; the mousse-cli command will not work until Mousse is reinstalled."
mousse_cli_done:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0

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
