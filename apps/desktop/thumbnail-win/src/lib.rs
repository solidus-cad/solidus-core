//! Explorer thumbnail handler of the .vpart / .vasm files (COM in-process server, IThumbnailProvider).
//!
//! The application stores a JPEG image of the 3D view, `thumbnail.jpg`, uncompressed at the root of the archive
//! (apps/web/src/docfiles/thumbnail.ts); `thumbnail.rs` of the desktop application finds it by reading only the
//! central directory and that entry. Explorer gives the file as a stream (IInitializeWithStream), then asks for a
//! bitmap of at most `cx` pixels (IThumbnailProvider): the JPEG is decoded and scaled with WIC.
//!
//! Registered per user by the installer (apps/desktop/src-tauri/windows/hooks.nsh): CLSID below, InprocServer32 =
//! this DLL, and `.vpart` / `.vasm` → ShellEx\{e357fccd-a995-4576-b01f-234630154e96} = CLSID. Explorer runs
//! thumbnail handlers in an isolated surrogate process (dllhost.exe).

#![cfg(windows)]
#![allow(non_snake_case)]

#[path = "../../src-tauri/src/thumbnail.rs"]
#[allow(dead_code)]
mod thumbnail;

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, Ordering};

use windows::core::{implement, Interface, Ref, Result, GUID, HRESULT};
use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_POINTER, S_FALSE, S_OK};
use windows::Win32::Graphics::Gdi::{CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{CoCreateInstance, IClassFactory, IClassFactory_Impl, IStream, CLSCTX_INPROC_SERVER, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl};
use windows::Win32::UI::Shell::{IThumbnailProvider, IThumbnailProvider_Impl, WTSAT_RGB, WTS_ALPHATYPE};
use windows_core::{IUnknown, BOOL};

/// CLSID of the handler (also written by hooks.nsh).
pub const CLSID_SOLIDUS_THUMBNAIL: GUID = GUID::from_u128(0x2d4edcf3_9d60_4b39_930d_a0afb5d77707);

/// Live objects and LockServer calls: the DLL is unloaded only when there are none.
static REFS: AtomicIsize = AtomicIsize::new(0);

struct Guard;
impl Guard {
    fn new() -> Self {
        REFS.fetch_add(1, Ordering::SeqCst);
        Guard
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        REFS.fetch_sub(1, Ordering::SeqCst);
    }
}

#[implement(IInitializeWithStream, IThumbnailProvider)]
struct Provider {
    jpeg: RefCell<Option<Vec<u8>>>,
    _guard: Guard,
}

impl IInitializeWithStream_Impl for Provider_Impl {
    fn Initialize(&self, pstream: Ref<'_, IStream>, _grfmode: u32) -> Result<()> {
        let stream = pstream.ok()?;
        let mut stat = STATSTG::default();
        unsafe { stream.Stat(&mut stat, STATFLAG_NONAME)? };
        let jpeg = thumbnail::extract(stat.cbSize, |offset, len| {
            unsafe { stream.Seek(offset as i64, STREAM_SEEK_SET, None) }.ok()?;
            let mut buf = vec![0u8; len];
            let mut done = 0usize;
            while done < len {
                let mut read = 0u32;
                let hr = unsafe { stream.Read(buf[done..].as_mut_ptr().cast(), (len - done) as u32, Some(&mut read)) };
                if hr.is_err() || read == 0 {
                    return None;
                }
                done += read as usize;
            }
            Some(buf)
        });
        *self.jpeg.borrow_mut() = jpeg;
        Ok(())
    }
}

impl IThumbnailProvider_Impl for Provider_Impl {
    fn GetThumbnail(&self, cx: u32, phbmp: *mut HBITMAP, pdwalpha: *mut WTS_ALPHATYPE) -> Result<()> {
        if phbmp.is_null() || pdwalpha.is_null() {
            return Err(E_POINTER.into());
        }
        let jpeg = self.jpeg.borrow();
        // No stored image (file saved by an earlier version, or not a part / assembly): Explorer shows the icon.
        let jpeg = jpeg.as_deref().ok_or_else(|| windows::core::Error::from(E_FAIL))?;
        let bitmap = decode(jpeg, cx.clamp(1, 2048))?;
        unsafe {
            *phbmp = bitmap;
            *pdwalpha = WTSAT_RGB;
        }
        Ok(())
    }
}

/// JPEG → top-down 32-bit DIB, longest side `cx` at most (never enlarged).
fn decode(jpeg: &[u8], cx: u32) -> Result<HBITMAP> {
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = factory.CreateStream()?;
        stream.InitializeFromMemory(jpeg)?;
        let decoder = factory.CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)?;
        let frame = decoder.GetFrame(0)?;
        let (mut w, mut h) = (0u32, 0u32);
        frame.GetSize(&mut w, &mut h)?;
        if w == 0 || h == 0 {
            return Err(E_FAIL.into());
        }
        let scale = (cx as f64 / w.max(h) as f64).min(1.0);
        let (tw, th) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
        let scaler = factory.CreateBitmapScaler()?;
        scaler.Initialize(&frame, tw, th, WICBitmapInterpolationModeFant)?;
        let converter = factory.CreateFormatConverter()?;
        converter.Initialize(&scaler, &GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;

        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: tw as i32,
                biHeight: -(th as i32), // top-down, as WIC copies the rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        if bits.is_null() {
            let _ = DeleteObject(bitmap.into());
            return Err(E_FAIL.into());
        }
        let stride = tw * 4;
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), (stride * th) as usize);
        if let Err(e) = converter.CopyPixels(std::ptr::null(), stride, pixels) {
            let _ = DeleteObject(bitmap.into());
            return Err(e);
        }
        Ok(bitmap)
    }
}

#[implement(IClassFactory)]
struct Factory {
    _guard: Guard,
}

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, punkouter: Ref<'_, IUnknown>, riid: *const GUID, ppvobject: *mut *mut c_void) -> Result<()> {
        if ppvobject.is_null() || riid.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *ppvobject = std::ptr::null_mut() };
        if punkouter.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let unknown: IUnknown = Provider { jpeg: RefCell::new(None), _guard: Guard::new() }.into();
        unsafe { unknown.query(riid, ppvobject).ok() }
    }

    fn LockServer(&self, flock: BOOL) -> Result<()> {
        if flock.as_bool() {
            REFS.fetch_add(1, Ordering::SeqCst);
        } else {
            REFS.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    if rclsid.is_null() || riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    if *rclsid != CLSID_SOLIDUS_THUMBNAIL {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = Factory { _guard: Guard::new() }.into();
    factory.query(riid, ppv)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if REFS.load(Ordering::SeqCst) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}
