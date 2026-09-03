#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <softpub.h>
#include <wintrust.h>
#include <cwctype>
#include <string>
#include <vector>

namespace
{
bool ContainsCaseInsensitive(const std::wstring& value, const std::wstring& expected)
{
    std::wstring normalizedValue(value);
    std::wstring normalizedExpected(expected);
    for (std::size_t index = 0; index < normalizedValue.size(); ++index)
    {
        normalizedValue[index] = static_cast<wchar_t>(std::towlower(normalizedValue[index]));
    }
    for (std::size_t index = 0; index < normalizedExpected.size(); ++index)
    {
        normalizedExpected[index] = static_cast<wchar_t>(std::towlower(normalizedExpected[index]));
    }
    return normalizedValue.find(normalizedExpected) != std::wstring::npos;
}

bool VerifyTrust(const wchar_t* path)
{
    WINTRUST_FILE_INFO fileInfo = {};
    fileInfo.cbStruct = sizeof(fileInfo);
    fileInfo.pcwszFilePath = path;

    WINTRUST_DATA trustData = {};
    trustData.cbStruct = sizeof(trustData);
    trustData.dwUIChoice = WTD_UI_NONE;
    trustData.fdwRevocationChecks = WTD_REVOKE_NONE;
    trustData.dwUnionChoice = WTD_CHOICE_FILE;
    trustData.pFile = &fileInfo;
    trustData.dwStateAction = WTD_STATEACTION_IGNORE;
    trustData.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;

    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    return WinVerifyTrust(NULL, &action, &trustData) == ERROR_SUCCESS;
}

bool ReadVersionString(const wchar_t* path, const wchar_t* name, std::wstring& value)
{
    DWORD ignored = 0;
    DWORD size = GetFileVersionInfoSizeW(path, &ignored);
    if (size == 0 || size > 4 * 1024 * 1024)
    {
        return false;
    }
    std::vector<unsigned char> buffer(size);
    if (!GetFileVersionInfoW(path, 0, size, &buffer[0]))
    {
        return false;
    }

    struct Translation
    {
        WORD language;
        WORD codePage;
    };
    Translation* translations = NULL;
    UINT translationBytes = 0;
    if (!VerQueryValueW(&buffer[0], L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translations), &translationBytes)
        || translations == NULL || translationBytes < sizeof(Translation))
    {
        return false;
    }

    wchar_t query[160] = {};
    if (swprintf_s(query, _countof(query), L"\\StringFileInfo\\%04x%04x\\%s", translations[0].language, translations[0].codePage, name) < 0)
    {
        return false;
    }
    wchar_t* result = NULL;
    UINT resultLength = 0;
    if (!VerQueryValueW(&buffer[0], query, reinterpret_cast<void**>(&result), &resultLength)
        || result == NULL || resultLength <= 1)
    {
        return false;
    }
    value.assign(result, resultLength - 1);
    return true;
}
}

int wmain(int argc, wchar_t** argv)
{
    if (argc != 2 || GetFileAttributesW(argv[1]) == INVALID_FILE_ATTRIBUTES)
    {
        return 2;
    }
    if (!VerifyTrust(argv[1]))
    {
        return 3;
    }
    std::wstring company;
    std::wstring product;
    if (!ReadVersionString(argv[1], L"CompanyName", company)
        || !ContainsCaseInsensitive(company, L"Microsoft Corporation"))
    {
        return 4;
    }
    if (!ReadVersionString(argv[1], L"ProductName", product)
        || !ContainsCaseInsensitive(product, L".NET Framework"))
    {
        return 5;
    }
    return 0;
}
