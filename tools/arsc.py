import struct

def u16(b,o): return struct.unpack_from('<H',b,o)[0]
def u32(b,o): return struct.unpack_from('<I',b,o)[0]

class SP:
    def __init__(self, b, o):
        assert u16(b,o)==0x0001, 'not a string pool'
        self.hs=u16(b,o+2); self.size=u32(b,o+4)
        self.count=u32(b,o+8); self.styles=u32(b,o+12); self.flags=u32(b,o+16)
        self.strs=o+u32(b,o+20); self.data=self.strs
        self.o=o; self.b=b; self.utf8=bool(self.flags & 0x100)
    def get(self,i):
        b=self.b; o=self.o+self.hs+i*4
        p=self.data+u32(b,o)
        if self.utf8:
            n=b[p]; p+=1
            if n & 0x80: p+=1
            l=b[p]; p+=1
            if l & 0x80: l=((l&0x7f)<<8)|b[p]; p+=1
            return b[p:p+l].decode('utf-8')
        else:
            n=u16(b,p); p+=2
            if n & 0x8000: n=((n&0x7fff)<<16)|u16(b,p); p+=2
            return b[p:p+n*2].decode('utf-16-le')

def config(b,o):
    """Parse ResTable_config: return (size, density, lang, locale)"""
    size=u32(b,o)
    dens=u16(b,o+14) if size>=16 else 0
    lang=b[o+8:o+10].decode('ascii','ignore')
    loc=b[o+8:o+14].decode('ascii','ignore')
    return size,dens,lang,loc

def parse(b):
    """Yield (resid, typename, keyname, dtype, data, configTuple)"""
    assert u16(b,0)==0x0002
    total=u32(b,4); n=u32(b,8)
    o=u16(b,2)
    out=[]
    while o < total and u16(b,o)==0x0001:
        o += u32(b,o+4)
    for _ in range(n):
        assert u16(b,o)==0x0200, hex(u16(b,o))
        hs=u16(b,o+2); psize=u32(b,o+4)
        pid=u32(b,o+8)
        tstr=o+u32(b,o+268); kstr=o+u32(b,o+276)
        tp=SP(b,tstr); kp=SP(b,kstr)
        p=o+hs
        end=o+psize
        types={}
        while p < end:
            t=u16(b,p); ths=u16(b,p+2); tsz=u32(b,p+4)
            if t==0x0201:
                tid=b[p+8]; tflags=b[p+9]; ecount=u32(b,p+12); estart=u32(b,p+16)
                cfg=config(b,p+20)
                offs=p+ths
                for i in range(ecount):
                    if tflags & 0x01:
                        idx=u16(b,offs+i*4); eo=u16(b,offs+i*4+2)*4
                        i=idx
                    elif tflags & 0x02:
                        eo=u16(b,offs+i*2)
                        if eo==0xffff: continue
                        eo*=4
                    else:
                        eo=u32(b,offs+i*4)
                        if eo==0xffffffff: continue
                    q=p+estart+eo
                    esz=u16(b,q); flags=u16(b,q+2); key=u32(b,q+4)
                    if flags & 1:
                        out.append(((pid<<24)|(tid<<16)|i, tp.get(tid-1) if tid-1<tp.count else '?', kp.get(key), 'complex',0,cfg)); continue
                    v=q+esz
                    dtype=b[v+3]; data=u32(b,v+4)
                    out.append(((pid<<24)|(tid<<16)|i, tp.get(tid-1) if tid-1<tp.count else '?', kp.get(key), dtype, data, cfg))
            elif t==0x0202:
                pass
            p+=tsz
        o+=psize
    return out
