package com.example.bpkeeper;

import java.util.UUID;

/**
 * 小米 MiBeacon 广播解析（iHealth 血压计 ihealth.bpm.bpx1，productId=8120）。
 *
 * 帧结构（小端）：
 *   u16 frameControl
 *   u16 productId = 8120 (0x1FB8 -> 字节 B8 1F)
 *   u8  counter
 *   [6B MAC，frameControl bit4=0x10 时存在，存储为反序]
 *   [1B capability，frameControl bit5=0x20 时存在；若 capability bit5=0x20 再 +1B]
 *   payload（加密时为 AES-CCM 密文）
 *   [3B random + 4B tag，frameControl bit3=0x08 加密时存在]
 *
 * 加密：AES-CCM，key=bindkey(16B)，nonce = reverse(MAC 6B) + serviceData[2:5] + random(3B)，
 *       AAD = 0x11，tag=4B。
 *
 * 解密后 payload 为 TLV：u16 objectId, u8 len, value；len==9 表示一条血压测量：
 *   value[0:4] 测量时间（u32 LE，自 2000-01-01 00:00:00 UTC+8 起的秒数）
 *   value[4:6] 收缩压（u16 LE）
 *   value[6]   舒张压
 *   value[7]   脉率
 *   value[8]   flags（bit0 心律不齐，bit1 体动）
 */
public final class MiBeaconParser {

    /** 小米 FE95 广播 Service UUID */
    public static final String FE95_UUID_STRING = "0000fe95-0000-1000-8000-00805f9b34fb";
    public static final UUID FE95_UUID = UUID.fromString(FE95_UUID_STRING);

    /** iHealth 血压计产品 ID */
    public static final int PRODUCT_ID = 8120;

    /** 2000-01-01 00:00:00 UTC+8 的 epoch 毫秒 */
    private static final long BASE_MILLIS = 946656000000L;

    private static final byte AAD = 0x11;

    private MiBeaconParser() {
    }

    /**
     * 解析一条 FE95 service data。
     *
     * @param serviceData   Android ScanRecord.getServiceData(FE95_UUID)
     * @param deviceAddress 蓝牙设备地址（AA:BB:CC:DD:EE:FF），帧内无 MAC 时用于 nonce
     * @param bindkey       16 字节 bindkey
     * @return 解析出的测量值；不是 8120 / 未加密 / 解密失败 / 数据非法时返回 null
     */
    public static Measurement parse(byte[] serviceData, String deviceAddress, byte[] bindkey) {
        if (serviceData == null || serviceData.length < 13
                || bindkey == null || bindkey.length != 16) {
            return null;
        }
        try {
            int frameControl = u16(serviceData, 0);
            int productId = u16(serviceData, 2);
            if (productId != PRODUCT_ID) {
                return null;
            }

            int position = 4;
            // counter 1B
            int counter = serviceData[position] & 0xFF;
            position++;

            byte[] macDisplay;
            if ((frameControl & 0x10) != 0) {
                if (serviceData.length < position + 6) {
                    return null;
                }
                byte[] stored = new byte[6];
                System.arraycopy(serviceData, position, stored, 0, 6);
                position += 6;
                macDisplay = reverse(stored);
            } else {
                macDisplay = parseAddress(deviceAddress);
                if (macDisplay == null) {
                    return null;
                }
            }

            if ((frameControl & 0x20) != 0) {
                if (position >= serviceData.length) {
                    return null;
                }
                int capability = serviceData[position] & 0xFF;
                position++;
                if ((capability & 0x20) != 0) {
                    // io capability 额外 1 字节
                    position++;
                }
            }

            byte[] plainPayload;
            if ((frameControl & 0x08) != 0) {
                int tail = serviceData.length - 7;
                if (tail <= position) {
                    return null;
                }
                byte[] random = new byte[3];
                System.arraycopy(serviceData, tail, random, 0, 3);
                byte[] tag = new byte[4];
                System.arraycopy(serviceData, tail + 3, tag, 0, 4);
                byte[] ciphertext = new byte[tail - position];
                System.arraycopy(serviceData, position, ciphertext, 0, ciphertext.length);

                byte[] nonce = new byte[12];
                System.arraycopy(reverse(macDisplay), 0, nonce, 0, 6);
                System.arraycopy(serviceData, 2, nonce, 6, 3); // productId LE + counter
                System.arraycopy(random, 0, nonce, 9, 3);

                plainPayload = Ccm.decrypt(bindkey, nonce, new byte[]{AAD}, ciphertext, tag);
                if (plainPayload == null) {
                    return null;
                }
            } else {
                if (position > serviceData.length) {
                    return null;
                }
                plainPayload = new byte[serviceData.length - position];
                System.arraycopy(serviceData, position, plainPayload, 0, plainPayload.length);
            }

            return parseTlv(plainPayload);
        } catch (Throwable t) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ */

    private static Measurement parseTlv(byte[] payload) {
        if (payload == null || payload.length < 3) {
            return null;
        }
        int position = 0;
        while (position + 3 <= payload.length) {
            int length = payload[position + 2] & 0xFF;
            position += 3;
            if (position + length > payload.length) {
                break;
            }
            if (length == 9) {
                Measurement measurement = parseMeasurement(payload, position);
                if (measurement != null) {
                    return measurement;
                }
            }
            position += length;
        }
        return null;
    }

    private static Measurement parseMeasurement(byte[] payload, int offset) {
        long timeSeconds = u32(payload, offset);
        int systolic = u16(payload, offset + 4);
        int diastolic = payload[offset + 6] & 0xFF;
        int pulse = payload[offset + 7] & 0xFF;
        int flags = payload[offset + 8] & 0xFF;
        if (systolic < 40 || systolic > 260
                || diastolic < 20 || diastolic > 200
                || pulse < 20 || pulse > 250
                || systolic <= diastolic) {
            return null;
        }
        Measurement measurement = new Measurement();
        measurement.measuredAtMillis = BASE_MILLIS + timeSeconds * 1000L;
        measurement.systolic = systolic;
        measurement.diastolic = diastolic;
        measurement.pulse = pulse;
        measurement.irregular = (flags & 0x01) != 0;
        measurement.movement = (flags & 0x02) != 0;
        return measurement;
    }

    /* ------------------------------------------------------------------ */
    /* 工具方法                                                            */
    /* ------------------------------------------------------------------ */

    private static int u16(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    private static long u32(byte[] data, int offset) {
        return (long) (data[offset] & 0xFF)
                | ((long) (data[offset + 1] & 0xFF) << 8)
                | ((long) (data[offset + 2] & 0xFF) << 16)
                | ((long) (data[offset + 3] & 0xFF) << 24);
    }

    private static byte[] reverse(byte[] data) {
        if (data == null) {
            return null;
        }
        byte[] output = new byte[data.length];
        for (int i = 0; i < data.length; i++) {
            output[i] = data[data.length - 1 - i];
        }
        return output;
    }

    /** 把 "AA:BB:CC:DD:EE:FF" 转成 6 字节（显示顺序） */
    public static byte[] parseAddress(String address) {
        if (address == null) {
            return null;
        }
        String[] parts = address.trim().split(":");
        if (parts.length != 6) {
            return null;
        }
        byte[] output = new byte[6];
        try {
            for (int i = 0; i < 6; i++) {
                output[i] = (byte) Integer.parseInt(parts[i], 16);
            }
            return output;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 解析结果 */
    public static class Measurement {
        public long measuredAtMillis;
        public int systolic;
        public int diastolic;
        public int pulse;
        public boolean irregular;
        public boolean movement;
    }
}
