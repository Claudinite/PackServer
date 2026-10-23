# Optional check of transformers/http-requests.sql in a real DataFusion (the engine behind Logpush Transformers).
# Needs: pip install datafusion pyarrow. Run: python infra/zone/transformers/verify-datafusion.py
import json,sys,datafusion
from datafusion import SessionContext, SessionConfig
import os
HERE=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')
spec=json.load(open(os.path.join(HERE,'logpush.json')))
job=spec['jobs'][0]
sql=open(os.path.join(HERE,'transformers','http-requests.sql')).read().replace('{{FIELDS}}',', '.join(job['fields'])).replace('{{HOSTS}}',"'packs.claudinite.com'").replace('{{WHERE}}',job['where'])
cfg=SessionConfig().with_information_schema(True)
try: cfg=cfg.set('datafusion.sql_parser.enable_ident_normalization','false')
except Exception as e: print('cfg',e)
ctx=SessionContext(cfg)
import pyarrow as pa
rec=dict(spec['sampleRecord']); rec['ClientRequestHost']='packs.claudinite.com'
bad=0
for v in spec['vectors']:
    r=dict(rec); r['ClientIP']=v['ip']
    t=pa.Table.from_pylist([r])
    ctx.register_record_batches('http_requests',[t.to_batches()])
    out=ctx.sql(sql).to_pylist()
    got=out[0]['ClientNetwork'] if out else 'DROPPED'
    ok=got==v['network']; bad+=not ok
    print('ok ' if ok else 'BAD',repr(v['ip']),got, 'ClientIP' in (out[0] if out else {}))
    ctx.deregister_table('http_requests')
print('bad',bad)
