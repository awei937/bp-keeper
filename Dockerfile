FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Asia/Shanghai \
    BP_DATA_DIR=/data

WORKDIR /app

COPY backend/requirements.txt /app/requirements.txt
COPY wheelhouse /app/wheelhouse
RUN if find /app/wheelhouse -maxdepth 1 -name '*.whl' | grep -q .; then \
        echo "==> 使用离线 wheelhouse 安装依赖" \
        && pip install --no-cache-dir --no-index --find-links /app/wheelhouse -r /app/requirements.txt \
        && pip install --no-cache-dir --no-index --find-links /app/wheelhouse --no-deps rapidocr-onnxruntime==1.4.4; \
    else \
        echo "==> 在线安装依赖" \
        && printf 'precedence ::ffff:0:0/96 100\n' >> /etc/gai.conf \
        && (pip install --no-cache-dir --timeout 120 --retries 5 \
                -i https://pypi.tuna.tsinghua.edu.cn/simple \
                -r /app/requirements.txt \
            || pip install --no-cache-dir --timeout 120 --retries 5 \
                -i https://mirrors.aliyun.com/pypi/simple/ \
                -r /app/requirements.txt) \
        && (pip install --no-cache-dir --no-deps \
                -i https://pypi.tuna.tsinghua.edu.cn/simple \
                rapidocr-onnxruntime==1.4.4 \
            || pip install --no-cache-dir --no-deps \
                -i https://mirrors.aliyun.com/pypi/simple/ \
                rapidocr-onnxruntime==1.4.4); \
    fi

COPY backend/app /app/app
COPY ocr /app/app/ocr
COPY frontend /app/frontend

RUN mkdir -p /data/uploads

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=6s --start-period=25s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
