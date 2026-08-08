use super::RuntimeError;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Owns a self-relative security descriptor that grants pipe access only to the current user SID.
/// Keep this value alive until the Windows pipe handle has been created.
pub struct CurrentUserPipeSecurity {
    descriptor: *mut c_void,
    attributes: SECURITY_ATTRIBUTES,
}

impl CurrentUserPipeSecurity {
    pub fn new() -> Result<Self, RuntimeError> {
        let sid = current_user_sid_string()?;
        let sddl = format!("D:P(A;;GA;;;{sid})");
        let wide = to_wide(&sddl);
        let mut descriptor = null_mut();
        // SAFETY: wide is NUL terminated, descriptor is an out pointer and LocalFree owns the
        // returned self-relative security descriptor.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(RuntimeError::new(
                "current_user_pipe_security_descriptor_failed",
            ));
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        Ok(Self {
            descriptor,
            attributes,
        })
    }

    /// Returns the pointer Windows expects while creating a named pipe.
    ///
    /// The pointer remains valid only while this owner is alive. APIs used by this project consume
    /// it synchronously and do not retain it after the pipe handle is returned.
    pub fn attributes_ptr(&self) -> *mut c_void {
        (&raw const self.attributes).cast_mut().cast()
    }
}

impl Drop for CurrentUserPipeSecurity {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            // SAFETY: ConvertStringSecurityDescriptorToSecurityDescriptorW allocated this block.
            unsafe { LocalFree(self.descriptor) };
            self.descriptor = null_mut();
        }
    }
}

fn current_user_sid_string() -> Result<String, RuntimeError> {
    let mut token = null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle valid for OpenProcessToken.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(RuntimeError::windows("current_user_pipe_token_failed"));
    }
    let token = OwnedHandle(token);
    let mut required = 0_u32;
    // The first call intentionally obtains the required buffer size.
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required);
    }
    if required < size_of::<TOKEN_USER>() as u32 {
        return Err(RuntimeError::new("current_user_pipe_token_invalid"));
    }
    let words = (required as usize).div_ceil(size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    // SAFETY: buffer is pointer-aligned, writable, and at least `required` bytes long.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(RuntimeError::windows("current_user_pipe_token_failed"));
    }
    // SAFETY: successful TokenUser query wrote a TOKEN_USER at the start of the aligned buffer.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    if user.User.Sid.is_null() {
        return Err(RuntimeError::new("current_user_pipe_sid_invalid"));
    }
    let mut sid_text = null_mut();
    // SAFETY: the token buffer remains alive and contains a valid user SID.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid_text) } == 0 || sid_text.is_null() {
        return Err(RuntimeError::windows("current_user_pipe_sid_failed"));
    }
    let sid = wide_ptr_to_string(sid_text);
    // SAFETY: ConvertSidToStringSidW allocated this NUL-terminated string with LocalAlloc.
    unsafe { LocalFree(sid_text.cast()) };
    sid
}

fn wide_ptr_to_string(value: *const u16) -> Result<String, RuntimeError> {
    let mut length = 0_usize;
    // SAFETY: callers pass a valid NUL-terminated Windows string.
    unsafe {
        while *value.add(length) != 0 {
            length += 1;
            if length > 256 {
                return Err(RuntimeError::new("current_user_pipe_sid_invalid"));
            }
        }
        String::from_utf16(std::slice::from_raw_parts(value, length))
            .map_err(|_| RuntimeError::new("current_user_pipe_sid_invalid"))
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper exclusively owns the process-token handle.
            unsafe { CloseHandle(self.0) };
            self.0 = null_mut();
        }
    }
}
