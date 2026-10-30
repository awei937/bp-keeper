package com.example.bpkeeper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * 极简 FileProvider：给系统相机应用提供可写的 content:// 输出地址。
 * 仅暴露应用缓存目录下的 uploads/ 目录，不申请任何存储权限。
 */
public class UploadFileProvider extends ContentProvider {

    public static final String AUTHORITY = "com.example.bpkeeper.uploads";
    private static final String DIR_NAME = "uploads";
    private static final String[] DEFAULT_COLUMNS = {
            OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE
    };

    public static File uploadDir(Context context) {
        File dir = new File(context.getCacheDir(), DIR_NAME);
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    public static Uri newImageUri(Context context) {
        File dir = uploadDir(context);
        String name = "capture_" + System.currentTimeMillis() + ".jpg";
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(name)
                .build();
    }

    public static File fileFor(Context context, Uri uri) {
        if (uri == null) {
            return null;
        }
        String name = uri.getLastPathSegment();
        if (name == null || name.length() == 0) {
            return null;
        }
        name = name.replace('/', '_').replace('\\', '_');
        return new File(uploadDir(context), name);
    }

    public static boolean exists(Context context, Uri uri) {
        File f = fileFor(context, uri);
        return f != null && f.isFile() && f.length() > 0;
    }

    public static void deleteFile(Context context, Uri uri) {
        File f = fileFor(context, uri);
        if (f != null && f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    public static void cleanOldFiles(Context context) {
        File dir = new File(context.getCacheDir(), DIR_NAME);
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        for (File f : files) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f = fileFor(getContext(), uri);
        if (f == null) {
            return null;
        }
        String[] columns = projection != null ? projection : DEFAULT_COLUMNS;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) {
                row[i] = f.getName();
            } else if (OpenableColumns.SIZE.equals(columns[i])) {
                row[i] = f.length();
            } else {
                row[i] = null;
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("insert not supported");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        File f = fileFor(getContext(), uri);
        if (f != null && f.exists() && f.delete()) {
            return 1;
        }
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("update not supported");
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(getContext(), uri);
        if (f == null) {
            throw new FileNotFoundException("invalid uri: " + uri);
        }
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        int flags;
        if ("r".equals(mode)) {
            if (!f.exists()) {
                throw new FileNotFoundException(f.getAbsolutePath());
            }
            flags = ParcelFileDescriptor.MODE_READ_ONLY;
        } else if ("w".equals(mode) || "wt".equals(mode)) {
            flags = ParcelFileDescriptor.MODE_WRITE_ONLY
                    | ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_TRUNCATE;
        } else if ("wa".equals(mode)) {
            flags = ParcelFileDescriptor.MODE_WRITE_ONLY
                    | ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_APPEND;
        } else if ("rw".equals(mode)) {
            flags = ParcelFileDescriptor.MODE_READ_WRITE
                    | ParcelFileDescriptor.MODE_CREATE;
        } else if ("rwt".equals(mode)) {
            flags = ParcelFileDescriptor.MODE_READ_WRITE
                    | ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_TRUNCATE;
        } else {
            throw new FileNotFoundException("bad mode: " + mode);
        }
        try {
            return ParcelFileDescriptor.open(f, flags);
        } catch (IOException e) {
            FileNotFoundException fnf = new FileNotFoundException(e.getMessage());
            fnf.initCause(e);
            throw fnf;
        }
    }
}
