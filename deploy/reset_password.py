"""重置指定用户密码（保留所有数据）。用法：
docker cp deploy/reset_password.py bp-app:/tmp/reset_password.py
docker exec -e PYTHONPATH=/app bp-app python /tmp/reset_password.py <用户名> <新密码>
"""
import sys

from app import db
from app.security import hash_password

if len(sys.argv) != 3:
    print("用法: reset_password.py <用户名> <新密码>")
    sys.exit(1)
username, new_password = sys.argv[1], sys.argv[2]
if len(new_password) < 6:
    print("新密码至少 6 位")
    sys.exit(1)
pw_hash, salt = hash_password(new_password)
conn = db.connect()
try:
    cursor = conn.execute("UPDATE users SET pw_hash = ?, salt = ? WHERE username = ?", (pw_hash, salt, username))
    conn.commit()
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
if cursor.rowcount == 0:
    print(f"未找到用户: {username}")
    sys.exit(1)
print(f"已重置 {username} 的密码（数据未变动）")
