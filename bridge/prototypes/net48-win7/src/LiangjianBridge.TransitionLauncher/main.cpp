#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <algorithm>
#include <cctype>
#include <cwctype>
#include <string>
#include <vector>

namespace
{
const DWORD Net48MinimumRelease = 528040;
const wchar_t* Net48RegistryKey = L"SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full";
const wchar_t* Net48WebHash = L"0BBA3094588C4BFEC301939985222A20B340BF03431563DEC8B2B4478B06FFFA";
const wchar_t* Net48OfflineHash = L"0A3A390C47E639D0F7FC65B21195FEE6B7F65B066F80F70C60FAB191D14B7E40";

std::wstring ParentDirectory(const std::wstring& path)
{
    std::wstring::size_type separator = path.find_last_of(L"\\/");
    return separator == std::wstring::npos ? std::wstring() : path.substr(0, separator);
}

std::wstring Join(const std::wstring& left, const std::wstring& right)
{
    if (left.empty()) return right;
    return left + (left[left.size() - 1] == L'\\' ? L"" : L"\\") + right;
}

bool FileExists(const std::wstring& path)
{
    DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool ReadSmallFile(const std::wstring& path, std::string& value, DWORD maximumBytes)
{
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size = {};
    bool valid = GetFileSizeEx(file, &size) && size.QuadPart > 0
        && size.QuadPart <= maximumBytes;
    if (valid)
    {
        value.resize(static_cast<std::size_t>(size.QuadPart));
        DWORD read = 0;
        valid = ReadFile(file, &value[0], static_cast<DWORD>(value.size()), &read, NULL)
            && read == static_cast<DWORD>(value.size());
    }
    CloseHandle(file);
    return valid;
}

bool ValidVersion(const std::wstring& value)
{
    if (value.empty() || value.size() > 64 || value.front() == L'.' || value.back() == L'.') return false;
    unsigned int parts = 1;
    bool digit = false;
    for (std::size_t index = 0; index < value.size(); ++index)
    {
        wchar_t character = value[index];
        if (character >= L'0' && character <= L'9')
        {
            digit = true;
            continue;
        }
        if (character != L'.' || !digit || ++parts > 4) return false;
        digit = false;
    }
    return digit && parts >= 2;
}

bool ParseVersion(const std::wstring& value, std::vector<unsigned int>& parts)
{
    if (!ValidVersion(value)) return false;
    parts.clear();
    unsigned int current = 0;
    for (std::size_t index = 0; index <= value.size(); ++index)
    {
        if (index < value.size() && value[index] != L'.')
        {
            unsigned int digit = static_cast<unsigned int>(value[index] - L'0');
            if (current > 65535U / 10U || current * 10U + digit > 65535U) return false;
            current = current * 10U + digit;
        }
        else
        {
            parts.push_back(current);
            current = 0;
        }
    }
    return true;
}

bool ExtractJsonString(const std::string& json, const char* name, std::wstring& value)
{
    std::string key = std::string("\"") + name + "\"";
    std::string::size_type position = json.find(key);
    if (position == std::string::npos) return false;
    position = json.find(':', position + key.size());
    if (position == std::string::npos) return false;
    do { ++position; } while (position < json.size() && std::isspace(static_cast<unsigned char>(json[position])));
    if (position >= json.size() || json[position] != '"') return false;
    std::string::size_type end = json.find('"', position + 1);
    if (end == std::string::npos || end == position + 1 || end - position > 65) return false;
    value.clear();
    for (std::string::size_type index = position + 1; index < end; ++index)
    {
        unsigned char character = static_cast<unsigned char>(json[index]);
        if (character > 0x7f || character == '\\') return false;
        value.push_back(static_cast<wchar_t>(character));
    }
    return true;
}

bool ReadLegacyPointer(const std::wstring& installRoot, std::wstring& activeVersion,
    std::wstring& previousVersion, std::wstring& status)
{
    std::string json;
    if (!ReadSmallFile(Join(installRoot, L"current.json"), json, 64U * 1024U)
        || !ExtractJsonString(json, "active_version", activeVersion)
        || !ExtractJsonString(json, "last_known_good_version", previousVersion)
        || !ExtractJsonString(json, "status", status)
        || !ValidVersion(activeVersion) || !ValidVersion(previousVersion)
        || (status != L"pending" && status != L"healthy" && status != L"rolled_back")) return false;
    return true;
}

bool ReadTextVersion(const std::wstring& path, std::wstring& value)
{
    std::string text;
    if (!ReadSmallFile(path, text, 128)) return false;
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.pop_back();
    std::string::size_type start = 0;
    while (start < text.size() && std::isspace(static_cast<unsigned char>(text[start]))) ++start;
    value.assign(text.begin() + start, text.end());
    return ValidVersion(value);
}

DWORD ReadNet48Release(REGSAM view)
{
    HKEY key = NULL;
    DWORD release = 0;
    DWORD size = sizeof(release);
    DWORD type = 0;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, Net48RegistryKey, 0, KEY_QUERY_VALUE | view, &key) == ERROR_SUCCESS)
    {
        if (RegQueryValueExW(key, L"Release", NULL, &type, reinterpret_cast<BYTE*>(&release), &size)
            != ERROR_SUCCESS || type != REG_DWORD) release = 0;
        RegCloseKey(key);
    }
    return release;
}

DWORD Net48Release()
{
    return (std::max)(ReadNet48Release(KEY_WOW64_32KEY), ReadNet48Release(KEY_WOW64_64KEY));
}

std::wstring Quote(const std::wstring& value)
{
    std::wstring result = L"\"";
    unsigned int slashes = 0;
    for (std::size_t index = 0; index < value.size(); ++index)
    {
        wchar_t character = value[index];
        if (character == L'\\')
        {
            ++slashes;
        }
        else
        {
            if (character == L'"') result.append(slashes * 2 + 1, L'\\');
            else result.append(slashes, L'\\');
            slashes = 0;
            result.push_back(character);
        }
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

std::wstring ForwardedArguments(int count, wchar_t** values)
{
    std::wstring result;
    for (int index = 1; index < count; ++index)
    {
        if (!result.empty()) result.push_back(L' ');
        result += Quote(values[index]);
    }
    return result;
}

DWORD RunProcess(const std::wstring& executable, const std::wstring& arguments,
    const std::wstring& workingDirectory, const wchar_t* installRootEnvironment)
{
    std::wstring command = Quote(executable);
    if (!arguments.empty()) command += L" " + arguments;
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');
    std::wstring oldEnvironment;
    bool hadEnvironment = false;
    if (installRootEnvironment != NULL)
    {
        DWORD required = GetEnvironmentVariableW(L"LIANGJIAN_BRIDGE_INSTALL_ROOT", NULL, 0);
        if (required > 0)
        {
            std::vector<wchar_t> existing(required);
            DWORD copied = GetEnvironmentVariableW(L"LIANGJIAN_BRIDGE_INSTALL_ROOT",
                &existing[0], required);
            if (copied == 0 || copied >= required) return static_cast<DWORD>(-1);
            oldEnvironment.assign(&existing[0], copied);
            hadEnvironment = true;
        }
        if (!SetEnvironmentVariableW(L"LIANGJIAN_BRIDGE_INSTALL_ROOT", installRootEnvironment))
            return static_cast<DWORD>(-1);
    }
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process = {};
    BOOL started = CreateProcessW(executable.c_str(), &mutableCommand[0], NULL, NULL, FALSE, 0,
        NULL, workingDirectory.c_str(), &startup, &process);
    if (installRootEnvironment != NULL)
    {
        SetEnvironmentVariableW(L"LIANGJIAN_BRIDGE_INSTALL_ROOT",
            hadEnvironment ? oldEnvironment.c_str() : NULL);
    }
    if (!started) return static_cast<DWORD>(-1);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exitCode = static_cast<DWORD>(-1);
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return exitCode;
}

bool HashFile(const std::wstring& path, std::wstring& result)
{
    BCRYPT_ALG_HANDLE algorithm = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    HANDLE file = INVALID_HANDLE_VALUE;
    PUCHAR object = NULL;
    PUCHAR digest = NULL;
    DWORD objectBytes = 0;
    DWORD digestBytes = 0;
    DWORD returned = 0;
    bool success = false;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0
        || BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectBytes),
            sizeof(objectBytes), &returned, 0) < 0
        || BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&digestBytes),
            sizeof(digestBytes), &returned, 0) < 0) goto cleanup;
    object = static_cast<PUCHAR>(HeapAlloc(GetProcessHeap(), 0, objectBytes));
    digest = static_cast<PUCHAR>(HeapAlloc(GetProcessHeap(), 0, digestBytes));
    if (object == NULL || digest == NULL
        || BCryptCreateHash(algorithm, &hash, object, objectBytes, NULL, 0, 0) < 0) goto cleanup;
    file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (file == INVALID_HANDLE_VALUE) goto cleanup;
    for (;;)
    {
        BYTE buffer[64 * 1024];
        DWORD read = 0;
        if (!ReadFile(file, buffer, sizeof(buffer), &read, NULL)) goto cleanup;
        if (read == 0) break;
        if (BCryptHashData(hash, buffer, read, 0) < 0) goto cleanup;
    }
    if (BCryptFinishHash(hash, digest, digestBytes, 0) < 0 || digestBytes != 32) goto cleanup;
    result.clear();
    const wchar_t* hex = L"0123456789ABCDEF";
    for (DWORD index = 0; index < digestBytes; ++index)
    {
        result.push_back(hex[digest[index] >> 4]);
        result.push_back(hex[digest[index] & 15]);
    }
    success = true;

cleanup:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (hash != NULL) BCryptDestroyHash(hash);
    if (object != NULL) HeapFree(GetProcessHeap(), 0, object);
    if (digest != NULL) HeapFree(GetProcessHeap(), 0, digest);
    if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
    return success;
}

DWORD FileVersionMajor(const std::wstring& path)
{
    DWORD ignored = 0;
    DWORD size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (size == 0 || size > 4U * 1024U * 1024U) return MAXDWORD;
    std::vector<BYTE> data(size);
    VS_FIXEDFILEINFO* value = NULL;
    UINT bytes = 0;
    if (!GetFileVersionInfoW(path.c_str(), 0, size, &data[0])
        || !VerQueryValueW(&data[0], L"\\", reinterpret_cast<void**>(&value), &bytes)
        || value == NULL || bytes < sizeof(VS_FIXEDFILEINFO)) return MAXDWORD;
    return HIWORD(value->dwFileVersionMS);
}

bool NewerVersion(const std::vector<unsigned int>& left, const std::vector<unsigned int>& right)
{
    for (std::size_t index = 0; index < 4; ++index)
    {
        unsigned int lhs = index < left.size() ? left[index] : 0;
        unsigned int rhs = index < right.size() ? right[index] : 0;
        if (lhs != rhs) return lhs > rhs;
    }
    return false;
}

std::wstring FindLegacyLauncher(const std::wstring& installRoot)
{
    std::wstring versionsRoot = Join(installRoot, L"versions");
    WIN32_FIND_DATAW data = {};
    HANDLE search = FindFirstFileW(Join(versionsRoot, L"*").c_str(), &data);
    if (search == INVALID_HANDLE_VALUE) return std::wstring();
    std::wstring selected;
    std::vector<unsigned int> selectedVersion;
    do
    {
        if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
            || data.cFileName[0] == L'.') continue;
        std::wstring version(data.cFileName);
        std::vector<unsigned int> parts;
        if (!ParseVersion(version, parts)) continue;
        std::wstring candidate = Join(Join(Join(versionsRoot, version), L"launcher"),
            L"AURUMBridge.Launcher.exe");
        if (!FileExists(candidate) || FileVersionMajor(candidate) >= 4) continue;
        if (selected.empty() || NewerVersion(parts, selectedVersion))
        {
            selected = candidate;
            selectedVersion = parts;
        }
    } while (FindNextFileW(search, &data));
    FindClose(search);
    return selected;
}

bool RegisterResume(const std::wstring& launcher)
{
    HKEY key = NULL;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce",
        0, NULL, 0, KEY_SET_VALUE, NULL, &key, NULL) != ERROR_SUCCESS) return false;
    std::wstring command = Quote(launcher);
    LONG status = RegSetValueExW(key, L"LiangjianBridgeV4RuntimeResume", 0, REG_SZ,
        reinterpret_cast<const BYTE*>(command.c_str()),
        static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(key);
    return status == ERROR_SUCCESS;
}

DWORD RunElevatedRuntime(const std::wstring& runtime)
{
    std::wstring workingDirectory = ParentDirectory(runtime);
    SHELLEXECUTEINFOW execute = {};
    execute.cbSize = sizeof(execute);
    execute.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
    execute.lpVerb = L"runas";
    execute.lpFile = runtime.c_str();
    execute.lpParameters = L"/q /norestart";
    execute.lpDirectory = workingDirectory.c_str();
    execute.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&execute) || execute.hProcess == NULL) return static_cast<DWORD>(-1);
    WaitForSingleObject(execute.hProcess, INFINITE);
    DWORD exitCode = static_cast<DWORD>(-1);
    GetExitCodeProcess(execute.hProcess, &exitCode);
    CloseHandle(execute.hProcess);
    return exitCode;
}

enum RuntimeResult { RuntimeReady, RuntimeRestartRequired, RuntimeFailed };

RuntimeResult EnsureRuntime(const std::wstring& installRoot, const std::wstring& activeVersion,
    const std::wstring& launcher)
{
    if (Net48Release() >= Net48MinimumRelease) return RuntimeReady;
    std::wstring prerequisite = Join(Join(Join(installRoot, L"versions"), activeVersion), L"prerequisites");
    std::wstring runtime = Join(prerequisite, L"ndp48-web.exe");
    if (!FileExists(runtime)) runtime = Join(prerequisite, L"NDP48-x86-x64-AllOS-ENU.exe");
    std::wstring verifier = Join(prerequisite, L"LiangjianBridge.AuthenticodeVerifier.exe");
    std::wstring hash;
    if (!FileExists(runtime) || !FileExists(verifier) || !HashFile(runtime, hash)
        || (hash != Net48WebHash && hash != Net48OfflineHash)
        || RunProcess(verifier, Quote(runtime), prerequisite, NULL) != 0) return RuntimeFailed;
    DWORD exitCode = RunElevatedRuntime(runtime);
    if (exitCode == 0 && Net48Release() >= Net48MinimumRelease) return RuntimeReady;
    if (exitCode == 3010 || exitCode == 1641 || exitCode == 0)
    {
        return RegisterResume(launcher) ? RuntimeRestartRequired : RuntimeFailed;
    }
    return RuntimeFailed;
}

void ShowError(const wchar_t* message)
{
    MessageBoxW(NULL, message, L"量见智桥", MB_OK | MB_ICONERROR);
}
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, wchar_t*, int)
{
    int count = 0;
    wchar_t** values = CommandLineToArgvW(GetCommandLineW(), &count);
    if (values == NULL || count < 1) return 1;
    std::vector<wchar_t> executableBuffer(32768);
    DWORD length = GetModuleFileNameW(NULL, &executableBuffer[0], static_cast<DWORD>(executableBuffer.size()));
    if (length == 0 || length >= static_cast<DWORD>(executableBuffer.size()))
    {
        LocalFree(values);
        return 1;
    }
    std::wstring launcher(&executableBuffer[0], length);
    std::wstring installRoot = ParentDirectory(launcher);
    std::wstring arguments = ForwardedArguments(count, values);
    bool automatic = count == 2 && std::wstring(values[1]) == L"--autostart";
    bool uninstall = count == 2 && std::wstring(values[1]) == L"--uninstall";

    std::wstring activeVersion;
    std::wstring previousVersion;
    std::wstring legacyStatus;
    bool legacyPointer = ReadLegacyPointer(installRoot, activeVersion, previousVersion, legacyStatus);
    std::wstring currentVersion;
    bool v4Pointer = ReadTextVersion(Join(Join(installRoot, L"versions"), L"current.txt"), currentVersion);
    if (!uninstall && v4Pointer && (!legacyPointer
        || (currentVersion == activeVersion && legacyStatus == L"healthy")))
    {
        std::wstring managed = Join(Join(Join(Join(installRoot, L"versions"), currentVersion), L"launcher"),
            L"LiangjianBridge.Launcher.exe");
        if (FileExists(managed) && Net48Release() >= Net48MinimumRelease)
        {
            DWORD result = RunProcess(managed, arguments, ParentDirectory(managed), installRoot.c_str());
            LocalFree(values);
            return result == static_cast<DWORD>(-1) ? 1 : static_cast<int>(result);
        }
    }

    std::wstring legacy = FindLegacyLauncher(installRoot);
    if (uninstall)
    {
        if (!legacy.empty())
        {
            DWORD result = RunProcess(legacy, arguments, ParentDirectory(legacy), NULL);
            LocalFree(values);
            return result == static_cast<DWORD>(-1) ? 1 : static_cast<int>(result);
        }
        std::wstring inno = Join(installRoot, L"unins000.exe");
        if (FileExists(inno))
        {
            DWORD result = RunProcess(inno, std::wstring(), installRoot, NULL);
            LocalFree(values);
            return result == static_cast<DWORD>(-1) ? 1 : static_cast<int>(result);
        }
    }

    if (legacyPointer)
    {
        std::vector<unsigned int> parts;
        if (ParseVersion(activeVersion, parts) && !parts.empty() && parts[0] >= 4
            && Net48Release() < Net48MinimumRelease)
        {
            RuntimeResult runtime = EnsureRuntime(installRoot, activeVersion, launcher);
            if (runtime == RuntimeRestartRequired)
            {
                if (!automatic) MessageBoxW(NULL,
                    L".NET Framework 4.8 已安装，需要重启 Windows。重启后量见智桥会自动继续升级。",
                    L"量见智桥", MB_OK | MB_ICONINFORMATION);
                LocalFree(values);
                return 0;
            }
        }
        if (!legacy.empty())
        {
            DWORD result = RunProcess(legacy, arguments, ParentDirectory(legacy), NULL);
            LocalFree(values);
            return result == static_cast<DWORD>(-1) ? 1 : static_cast<int>(result);
        }
    }

    if (!automatic) ShowError(L"量见智桥无法启动，升级文件不完整。请重新运行安装包修复。");
    LocalFree(values);
    return 1;
}
