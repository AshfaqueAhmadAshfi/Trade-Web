; ============================================================
;  SoftradeX Trade - Windows installer script (Inno Setup 6)
;
;  Rebuild steps:
;    1. Stage the clean app into  ..\dist\stage\SoftradeX-Trade
;    2. ISCC.exe installer\SoftradeX-Trade.iss
;  Output:  ..\dist\SoftradeX-Trade-Setup-v1.0.exe
;
;  The installed app is fully per-user (no admin needed):
;  first run of start.bat creates the private Python venv.
; ============================================================

#define MyAppName      "SoftradeX Trade"
#define MyAppVersion   "1.0"
#define MyAppPublisher "SoftradeX"
#define StageDir       "..\dist\stage\SoftradeX-Trade"

[Setup]
AppId={{B4D6E9F0-2C31-4A7D-9E58-6F1A7C3D8B25}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName}
SolidCompression=yes
WizardStyle=modern
MinVersion=10.0
OutputDir=..\dist
OutputBaseFileName=SoftradeX-Trade-Setup-v{#MyAppVersion}

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; Comment: "Run SoftradeX Trade (one click)"; IconFilename: "{sys}\shell32.dll"; IconIndex: 137
Name: "{group}\{#MyAppName} - Repair Setup"; Filename: "{app}\setup.bat"; WorkingDir: "{app}"; Comment: "Reinstall the Python environment (setup.bat)"; IconFilename: "{sys}\shell32.dll"; IconIndex: 167
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; Tasks: desktopicon; Comment: "Run SoftradeX Trade (one click)"; IconFilename: "{sys}\shell32.dll"; IconIndex: 137

[Run]
Filename: "{app}\start.bat"; WorkingDir: "{app}"; Description: "Launch {#MyAppName} now (first run installs Python packages, a few minutes)"; Flags: postinstall nowait skipifsilent runascurrentuser

[UninstallDelete]
; everything lives under {app}; nothing else is touched
