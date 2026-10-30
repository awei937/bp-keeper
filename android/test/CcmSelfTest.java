import com.example.bpkeeper.Ccm;
import com.example.bpkeeper.MiBeaconParser;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/**
 * 纯 JDK 自测（不参与 APK 构建）：
 *   1) AES-CCM 官方测试向量解密/加密/tag 校验
 *   2) 构造合成 MiBeacon 广播帧，验证 MiBeaconParser 解析
 *
 * 运行：
 *   javac -d /tmp/bp-ccm-test src/com/wei/bpkeeper/Ccm.java src/com/wei/bpkeeper/MiBeaconParser.java test/CcmSelfTest.java
 *   java -cp /tmp/bp-ccm-test CcmSelfTest
 */
public class CcmSelfTest {

    private static final long BASE_MILLIS = 946656000000L; // 2000-01-01T00:00:00 UTC+8

    public static void main(String[] args) {
        boolean ok = true;
        ok &= testCcmVector();
        ok &= testMiBeacon();
        ok &= testInvalidFrames();
        System.out.println(ok ? "ALL_TESTS_PASS" : "TESTS_FAILED");
        if (!ok) {
            System.exit(1);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 1) AES-CCM 测试向量                                                 */
    /* ------------------------------------------------------------------ */

    private static boolean testCcmVector() {
        byte[] key = hex("000102030405060708090a0b0c0d0e0f");
        byte[] nonce = hex("101112131415161718191a1b");
        byte[] aad = hex("11");
        byte[] plain = hex("1b560914b55c3273005b4500");
        byte[] cipher = hex("38e3b0b4f7a81fc10af73ac0");
        byte[] tag = hex("b34851ac");

        boolean pass = true;

        byte[] decrypted = Ccm.decrypt(key, nonce, aad, cipher, tag);
        boolean decryptOk = decrypted != null && Arrays.equals(decrypted, plain);
        System.out.println("CCM vector decrypt     : " + (decryptOk ? "PASS" : "FAIL")
                + (decryptOk ? "" : " got=" + hexString(decrypted)));
        pass &= decryptOk;

        byte[][] encrypted = Ccm.encrypt(key, nonce, aad, plain);
        boolean encryptOk = encrypted != null
                && Arrays.equals(encrypted[0], cipher)
                && Arrays.equals(encrypted[1], tag);
        System.out.println("CCM vector encrypt     : " + (encryptOk ? "PASS" : "FAIL"));
        pass &= encryptOk;

        byte[] badTag = tag.clone();
        badTag[0] ^= 0x01;
        boolean tamperOk = Ccm.decrypt(key, nonce, aad, cipher, badTag) == null;
        System.out.println("CCM tampered tag reject: " + (tamperOk ? "PASS" : "FAIL"));
        pass &= tamperOk;

        return pass;
    }

    /* ------------------------------------------------------------------ */
    /* 2) 合成 MiBeacon 帧解析                                             */
    /* ------------------------------------------------------------------ */

    private static boolean testMiBeacon() {
        byte[] bindkey = hex("000102030405060708090a0b0c0d0e0f");
        String address = "AA:BB:CC:DD:EE:FF";
        long seconds = 123456789L;
        int systolic = 137;
        int diastolic = 87;
        int pulse = 78;
        int flags = 0x01; // 心律不齐

        long measuredAt = BASE_MILLIS + seconds * 1000L;
        byte[] tlv = buildMeasurementTlv(seconds, systolic, diastolic, pulse, flags);

        boolean pass = true;
        // A: 加密 + 帧内 MAC + capability
        pass &= buildAndParse("A fc=0x38 cap=0x00", bindkey, address, 0x0038, 0x00, false,
                tlv, measuredAt, systolic, diastolic, pulse, true, false);
        // B: 加密 + 帧内 MAC + capability(0x20) + 额外 io capability 字节
        pass &= buildAndParse("B fc=0x38 cap=0x20", bindkey, address, 0x0038, 0x20, true,
                tlv, measuredAt, systolic, diastolic, pulse, true, false);
        // C: 加密 + 无 MAC（nonce 用设备地址）+ 无 capability
        pass &= buildAndParse("C fc=0x08", bindkey, address, 0x0008, 0x00, false,
                tlv, measuredAt, systolic, diastolic, pulse, true, false);
        // D: 加密 + MAC + capability，flags=0x02（体动）
        byte[] tlvMovement = buildMeasurementTlv(seconds, 152, 93, 66, 0x02);
        pass &= buildAndParse("D fc=0x38 flags=0x02", bindkey, address, 0x0038, 0x00, false,
                tlvMovement, BASE_MILLIS + seconds * 1000L, 152, 93, 66, false, true);
        return pass;
    }

    private static boolean buildAndParse(String label, byte[] bindkey, String address,
                                         int frameControl, int capability, boolean withIoExtra,
                                         byte[] tlv, long expectedMeasuredAt,
                                         int expectedSys, int expectedDia, int expectedPulse,
                                         boolean expectedIrregular, boolean expectedMovement) {
        try {
            byte[] macDisplay = MiBeaconParser.parseAddress(address);
            byte[] random = new byte[]{0x11, 0x22, 0x33};
            int productId = 8120;
            int counter = 7;

            ByteArrayOutputStream header = new ByteArrayOutputStream();
            writeU16Le(header, frameControl);
            writeU16Le(header, productId);
            header.write(counter);
            if ((frameControl & 0x10) != 0) {
                header.write(reverse(macDisplay), 0, 6); // 帧内存储为反序
            }
            if ((frameControl & 0x20) != 0) {
                header.write(capability);
                if (withIoExtra) {
                    header.write(0x00);
                }
            }

            byte[] nonce = new byte[12];
            System.arraycopy(reverse(macDisplay), 0, nonce, 0, 6);
            nonce[6] = (byte) (productId & 0xFF);
            nonce[7] = (byte) ((productId >> 8) & 0xFF);
            nonce[8] = (byte) counter;
            System.arraycopy(random, 0, nonce, 9, 3);

            byte[][] encrypted = Ccm.encrypt(bindkey, nonce, new byte[]{0x11}, tlv);
            if (encrypted == null) {
                System.out.println("MiBeacon " + label + " : FAIL (encrypt null)");
                return false;
            }

            ByteArrayOutputStream frame = new ByteArrayOutputStream();
            writeBytes(frame, header.toByteArray());
            writeBytes(frame, encrypted[0]);
            writeBytes(frame, random);
            writeBytes(frame, encrypted[1]);
            byte[] serviceData = frame.toByteArray();

            MiBeaconParser.Measurement measurement =
                    MiBeaconParser.parse(serviceData, address, bindkey);

            boolean pass = measurement != null
                    && measurement.systolic == expectedSys
                    && measurement.diastolic == expectedDia
                    && measurement.pulse == expectedPulse
                    && measurement.irregular == expectedIrregular
                    && measurement.movement == expectedMovement
                    && measurement.measuredAtMillis == expectedMeasuredAt;
            System.out.println("MiBeacon " + label + " : " + (pass ? "PASS" : "FAIL"));
            if (!pass && measurement != null) {
                System.out.println("    got sys=" + measurement.systolic + " dia=" + measurement.diastolic
                        + " pulse=" + measurement.pulse + " irregular=" + measurement.irregular
                        + " movement=" + measurement.movement
                        + " measuredAt=" + measurement.measuredAtMillis
                        + " expectedAt=" + expectedMeasuredAt);
            }
            return pass;
        } catch (Throwable t) {
            System.out.println("MiBeacon " + label + " : FAIL (" + t + ")");
            return false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 3) 非法帧负向测试                                                   */
    /* ------------------------------------------------------------------ */

    private static boolean testInvalidFrames() {
        byte[] bindkey = hex("000102030405060708090a0b0c0d0e0f");
        String address = "AA:BB:CC:DD:EE:FF";
        long seconds = 123456789L;
        byte[] tlv = buildMeasurementTlv(seconds, 137, 87, 78, 0);
        boolean pass = true;

        try {
            // 错误 productId
            byte[] macDisplay = MiBeaconParser.parseAddress(address);
            byte[] random = new byte[]{0x11, 0x22, 0x33};
            int productId = 9999;
            int counter = 1;
            ByteArrayOutputStream header = new ByteArrayOutputStream();
            writeU16Le(header, 0x0038);
            writeU16Le(header, productId);
            header.write(counter);
            header.write(reverse(macDisplay), 0, 6);
            header.write(0x00);

            byte[] nonce = new byte[12];
            System.arraycopy(reverse(macDisplay), 0, nonce, 0, 6);
            nonce[6] = (byte) (productId & 0xFF);
            nonce[7] = (byte) ((productId >> 8) & 0xFF);
            nonce[8] = (byte) counter;
            System.arraycopy(random, 0, nonce, 9, 3);
            byte[][] encrypted = Ccm.encrypt(bindkey, nonce, new byte[]{0x11}, tlv);
            ByteArrayOutputStream frame = new ByteArrayOutputStream();
            writeBytes(frame, header.toByteArray());
            writeBytes(frame, encrypted[0]);
            writeBytes(frame, random);
            writeBytes(frame, encrypted[1]);
            boolean wrongProductRejected = MiBeaconParser.parse(frame.toByteArray(), address, bindkey) == null;
            System.out.println("MiBeacon wrong product: " + (wrongProductRejected ? "PASS" : "FAIL"));
            pass &= wrongProductRejected;

            // 错误 bindkey
            byte[] wrongKey = new byte[16];
            byte[] validFrame = buildFrame(bindkey, address, tlv, seconds);
            boolean wrongKeyRejected = MiBeaconParser.parse(validFrame, address, wrongKey) == null;
            System.out.println("MiBeacon wrong bindkey: " + (wrongKeyRejected ? "PASS" : "FAIL"));
            pass &= wrongKeyRejected;

            // 篡改 ciphertext
            byte[] tampered = buildFrame(bindkey, address, tlv, seconds);
            tampered[tampered.length - 8] ^= 0x01;
            boolean tamperRejected = MiBeaconParser.parse(tampered, address, bindkey) == null;
            System.out.println("MiBeacon tampered data: " + (tamperRejected ? "PASS" : "FAIL"));
            pass &= tamperRejected;

            // 生理值越界（sys<=dia）
            byte[] badTlv = buildMeasurementTlv(seconds, 80, 90, 70, 0);
            byte[] badFrame = buildFrame(bindkey, address, badTlv, seconds);
            boolean badValueRejected = MiBeaconParser.parse(badFrame, address, bindkey) == null;
            System.out.println("MiBeacon invalid range: " + (badValueRejected ? "PASS" : "FAIL"));
            pass &= badValueRejected;
        } catch (Throwable t) {
            System.out.println("MiBeacon negative tests: FAIL (" + t + ")");
            return false;
        }
        return pass;
    }

    private static byte[] buildFrame(byte[] bindkey, String address, byte[] tlv, long seconds) {
        byte[] macDisplay = MiBeaconParser.parseAddress(address);
        byte[] random = new byte[]{0x11, 0x22, 0x33};
        int productId = 8120;
        int counter = 3;
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        writeU16Le(header, 0x0038);
        writeU16Le(header, productId);
        header.write(counter);
        header.write(reverse(macDisplay), 0, 6);
        header.write(0x00);

        byte[] nonce = new byte[12];
        System.arraycopy(reverse(macDisplay), 0, nonce, 0, 6);
        nonce[6] = (byte) (productId & 0xFF);
        nonce[7] = (byte) ((productId >> 8) & 0xFF);
        nonce[8] = (byte) counter;
        System.arraycopy(random, 0, nonce, 9, 3);
        byte[][] encrypted = Ccm.encrypt(bindkey, nonce, new byte[]{0x11}, tlv);
        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        writeBytes(frame, header.toByteArray());
        writeBytes(frame, encrypted[0]);
        writeBytes(frame, random);
        writeBytes(frame, encrypted[1]);
        return frame.toByteArray();
    }

    /* ------------------------------------------------------------------ */
    /* 工具                                                                */
    /* ------------------------------------------------------------------ */

    private static byte[] buildMeasurementTlv(long seconds, int systolic, int diastolic,
                                              int pulse, int flags) {
        byte[] tlv = new byte[12];
        tlv[0] = 0x01; // objectId 0x4C01 (LE)
        tlv[1] = 0x4C;
        tlv[2] = 9;
        tlv[3] = (byte) (seconds & 0xFF);
        tlv[4] = (byte) ((seconds >> 8) & 0xFF);
        tlv[5] = (byte) ((seconds >> 16) & 0xFF);
        tlv[6] = (byte) ((seconds >> 24) & 0xFF);
        tlv[7] = (byte) (systolic & 0xFF);
        tlv[8] = (byte) ((systolic >> 8) & 0xFF);
        tlv[9] = (byte) diastolic;
        tlv[10] = (byte) pulse;
        tlv[11] = (byte) flags;
        return tlv;
    }

    private static void writeBytes(ByteArrayOutputStream out, byte[] data) {
        out.write(data, 0, data.length);
    }

    private static void writeU16Le(ByteArrayOutputStream out, int value) {
        out.write(value & 0xFF);
        out.write((value >> 8) & 0xFF);
    }

    private static byte[] reverse(byte[] data) {
        byte[] output = new byte[data.length];
        for (int i = 0; i < data.length; i++) {
            output[i] = data[data.length - 1 - i];
        }
        return output;
    }

    private static byte[] hex(String text) {
        int length = text.length() / 2;
        byte[] output = new byte[length];
        for (int i = 0; i < length; i++) {
            output[i] = (byte) Integer.parseInt(text.substring(i * 2, i * 2 + 2), 16);
        }
        return output;
    }

    private static String hexString(byte[] data) {
        if (data == null) {
            return "null";
        }
        StringBuilder builder = new StringBuilder(data.length * 2);
        for (byte b : data) {
            builder.append(String.format("%02x", b));
        }
        return builder.toString();
    }
}
