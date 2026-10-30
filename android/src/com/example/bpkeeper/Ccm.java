package com.example.bpkeeper;

import java.security.GeneralSecurityException;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * 极简 AES-CCM 实现（仅用于小米 MiBeacon 广播解密，不引入 BouncyCastle）。
 *
 * 参数固定：
 *   - key: 16 字节
 *   - nonce: 12 字节（L = 15 - 12 = 3，长度字段 3 字节）
 *   - AAD: 任意长度（本协议为 1 字节 0x11）
 *   - tag: 4 字节
 * AES 基于 JDK/Android 自带的 AES/ECB/NoPadding。
 *
 * 实现参考 RFC 3610：B0 / A0 / CTR 计数 / CBC-MAC，tag 先校验再返回明文。
 */
public final class Ccm {

    private static final int BLOCK_SIZE = 16;
    private static final int NONCE_LEN = 12;
    private static final int TAG_LEN = 4;
    private static final int L = 15 - NONCE_LEN; // 3

    private Ccm() {
    }

    /**
     * 解密并校验 tag。
     *
     * @return 明文；认证失败/key/nonce/tag 非法时返回 null
     */
    public static byte[] decrypt(byte[] key, byte[] nonce, byte[] aad, byte[] ciphertext, byte[] tag) {
        try {
            if (key == null || key.length != 16 || nonce == null || nonce.length != NONCE_LEN) {
                return null;
            }
            if (tag == null || tag.length != TAG_LEN) {
                return null;
            }
            byte[] data = ciphertext == null ? new byte[0] : ciphertext;
            byte[] plain = ctrXor(key, nonce, data);
            byte[] expectedTag = computeTag(key, nonce, aad, plain);
            if (!constantTimeEquals(expectedTag, tag)) {
                return null;
            }
            return plain;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 加密（自测/工具用）。
     *
     * @return 二维数组：{ciphertext, tag}；参数非法返回 null
     */
    public static byte[][] encrypt(byte[] key, byte[] nonce, byte[] aad, byte[] plaintext) {
        try {
            if (key == null || key.length != 16 || nonce == null || nonce.length != NONCE_LEN) {
                return null;
            }
            byte[] plain = plaintext == null ? new byte[0] : plaintext;
            byte[] ciphertext = ctrXor(key, nonce, plain);
            byte[] tag = computeTag(key, nonce, aad, plain);
            return new byte[][]{ciphertext, tag};
        } catch (Throwable t) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ */

    private static byte[] computeTag(byte[] key, byte[] nonce, byte[] aad, byte[] plain)
            throws GeneralSecurityException {
        byte[] b0 = new byte[BLOCK_SIZE];
        // flags: Adata=1(0x40) | (M-2)/2<<3 (M=4 -> 0x08) | L-1 (0x02) = 0x4A
        b0[0] = (byte) (0x40 | (((TAG_LEN - 2) / 2) << 3) | (L - 1));
        System.arraycopy(nonce, 0, b0, 1, NONCE_LEN);
        putU24(b0, 13, plain.length);

        byte[] x = aesEncryptBlock(key, b0);

        if (aad != null && aad.length > 0) {
            int aadLen = aad.length;
            int encodedLen = 2 + aadLen;
            byte[] encoded = new byte[encodedLen];
            encoded[0] = (byte) ((aadLen >> 8) & 0xFF);
            encoded[1] = (byte) (aadLen & 0xFF);
            System.arraycopy(aad, 0, encoded, 2, aadLen);

            int padded = ((encodedLen + BLOCK_SIZE - 1) / BLOCK_SIZE) * BLOCK_SIZE;
            byte[] paddedAad = new byte[padded];
            System.arraycopy(encoded, 0, paddedAad, 0, encodedLen);
            for (int offset = 0; offset < padded; offset += BLOCK_SIZE) {
                x = aesEncryptBlock(key, xorBlock(x, paddedAad, offset));
            }
        }

        for (int offset = 0; offset < plain.length; offset += BLOCK_SIZE) {
            byte[] block = new byte[BLOCK_SIZE];
            int count = Math.min(BLOCK_SIZE, plain.length - offset);
            System.arraycopy(plain, offset, block, 0, count);
            x = aesEncryptBlock(key, xorBlock(x, block, 0));
        }

        byte[] s0 = aesEncryptBlock(key, ctrBlock(nonce, 0));
        byte[] tag = new byte[TAG_LEN];
        for (int i = 0; i < TAG_LEN; i++) {
            tag[i] = (byte) (x[i] ^ s0[i]);
        }
        return tag;
    }

    private static byte[] ctrXor(byte[] key, byte[] nonce, byte[] data) throws GeneralSecurityException {
        byte[] output = new byte[data.length];
        int counter = 1;
        for (int offset = 0; offset < data.length; offset += BLOCK_SIZE) {
            byte[] stream = aesEncryptBlock(key, ctrBlock(nonce, counter));
            counter++;
            int count = Math.min(BLOCK_SIZE, data.length - offset);
            for (int i = 0; i < count; i++) {
                output[offset + i] = (byte) (data[offset + i] ^ stream[i]);
            }
        }
        return output;
    }

    private static byte[] ctrBlock(byte[] nonce, int counter) {
        byte[] block = new byte[BLOCK_SIZE];
        block[0] = (byte) (L - 1);
        System.arraycopy(nonce, 0, block, 1, NONCE_LEN);
        block[13] = (byte) ((counter >> 16) & 0xFF);
        block[14] = (byte) ((counter >> 8) & 0xFF);
        block[15] = (byte) (counter & 0xFF);
        return block;
    }

    private static byte[] aesEncryptBlock(byte[] key, byte[] block) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/ECB/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
        return cipher.doFinal(block);
    }

    private static byte[] xorBlock(byte[] a, byte[] b, int bOffset) {
        byte[] output = new byte[BLOCK_SIZE];
        for (int i = 0; i < BLOCK_SIZE; i++) {
            output[i] = (byte) (a[i] ^ b[bOffset + i]);
        }
        return output;
    }

    private static void putU24(byte[] target, int offset, int value) {
        target[offset] = (byte) ((value >> 16) & 0xFF);
        target[offset + 1] = (byte) ((value >> 8) & 0xFF);
        target[offset + 2] = (byte) (value & 0xFF);
    }

    private static boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) {
            return false;
        }
        int diff = 0;
        for (int i = 0; i < a.length; i++) {
            diff |= a[i] ^ b[i];
        }
        return diff == 0;
    }
}
