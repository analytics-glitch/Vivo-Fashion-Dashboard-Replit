#!/usr/bin/env python3
"""Disposable local PostgreSQL runner; never forwards application DB URLs."""
import os, shutil, socket, subprocess, sys, tempfile
from pathlib import Path

def port():
    s=socket.socket(); s.bind(("127.0.0.1",0)); p=s.getsockname()[1]; s.close(); return p
def main():
    binary=shutil.which("postgres")
    if not binary: raise RuntimeError("postgres is required for disposable identity tests")
    root=tempfile.TemporaryDirectory(prefix="identity-pg-"); root=Path(root.name); data=root/"data"; p=port(); user="identity_test"
    subprocess.run([str(Path(binary).parent/"initdb"),"-D",str(data),"--auth=trust","--no-locale",f"--username={user}"],check=True,stdout=subprocess.DEVNULL)
    try:
        subprocess.run([str(Path(binary).parent/"pg_ctl"),"-D",str(data),"-o",f"-h 127.0.0.1 -k {root} -p {p}","-w","start"],check=True,stdout=subprocess.DEVNULL)
        subprocess.run([str(Path(binary).parent/"createdb"),"-h","127.0.0.1","-p",str(p),"-U",user,"identity_test"],check=True)
        env=os.environ.copy(); env.pop("DATABASE_URL",None); env.pop("VIVO_DATABASE_URL",None); env["TEST_DATABASE_URL"]=f"postgresql://{user}@127.0.0.1:{p}/identity_test?sslmode=disable"; env["IDENTITY_EXPECTED_SOURCES"]="shopify:vivo-uganda"
        subprocess.run([sys.executable,"-m","unittest","-v","test_customer_identity_pg"],check=True,env=env)
    finally:
        subprocess.run([str(Path(binary).parent/"pg_ctl"),"-D",str(data),"-m","fast","-w","stop"],check=False,stdout=subprocess.DEVNULL)
if __name__=="__main__": main()