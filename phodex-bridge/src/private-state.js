// Protects bridge identity, service configuration and live pairing files for the current user.
const fs = require('node:fs');
const path = require('node:path');
const { powershellData, runPowerShell } = require('./powershell');
const protectedWindowsPaths = new Map();

function protectPrivatePath(filePath, { platform = process.platform, fsImpl = fs, execFileSyncImpl } = {}) {
  if (platform !== 'win32') {
    fsImpl.chmodSync(filePath, fsImpl.statSync(filePath).isDirectory() ? 0o700 : 0o600);
    return;
  }
  const stat = fsImpl.statSync(filePath);
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  if (protectedWindowsPaths.get(filePath) === identity) return;
  try {
    runPowerShell(`${powershellData({ path: filePath })}
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User;
      $item = Get-Item -LiteralPath $data.path -Force;
      if ($item.PSIsContainer) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity;
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
      } else {
        $acl = New-Object System.Security.AccessControl.FileSecurity;
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow');
      }
      $acl.SetOwner($sid);
      $acl.SetAccessRuleProtection($true, $false);
      $acl.AddAccessRule($rule);
      Set-Acl -LiteralPath $data.path -AclObject $acl;
    `, { execFileSyncImpl });
    protectedWindowsPaths.set(filePath, identity);
  } catch {
    throw new Error('Could not set private state permissions for the current Windows user. Check file ownership and NTFS ACL support.');
  }
}

function ensurePrivateDirectory(directory, options = {}) {
  const fsImpl = options.fsImpl || fs;
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  protectPrivatePath(directory, options);
}

function writePrivateFile(filePath, content, options = {}) {
  const fsImpl = options.fsImpl || fs;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // Create an empty file first so ACL failures cannot leave readable secrets behind.
  try { fsImpl.writeFileSync(filePath, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  protectPrivatePath(filePath, options);
  fsImpl.writeFileSync(filePath, content, { mode: 0o600 });
}

module.exports = { ensurePrivateDirectory, protectPrivatePath, writePrivateFile };
