# OCR 识别说明

## 输入

- 血压计屏幕照片（七段码数字，常见绿色 / 中性白屏、粉色机身）；
- App 历史记录截图（可能非常长、WebP 压缩、含「误动」等标签）。

## 流程

1. 图片在前端预览，上传到 `/api/ocr`（限制大小与格式）；
2. 后端 / OCR 模块使用 RapidOCR 检测文字，并对七段码区域做几何预处理；
3. 返回候选 `systolic / diastolic / pulse / confidence`；
4. **不会直接写库**：前端展示候选值，用户确认或修改；
5. 用户保存后走正常测量接口。

## 本地依赖

```bash
pip install -r backend/requirements.txt
pip install rapidocr-onnxruntime==1.4.4
```

模型由 RapidOCR 在首次使用时加载；离线部署可预置模型目录并通过代码中的路径配置引用。

## 限制

- 极端反光、模糊、倾斜、非标准排版可能识别失败；失败时手动输入；
- OCR 结果是辅助，不构成医疗判断；
- 上传原图会保存在数据目录，建议设置清理策略（默认保留期限可在代码中调整）。

## 测试

`backend/tests/smoke_test.py` 覆盖测量 CRUD 与基础 OCR 接口；OCR 回归需要准备自己的测试图片，避免提交真实健康数据。
