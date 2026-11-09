/**
 * The clay mouse fragment shader (bot-ui §4.3): signed distance fields ray-marched per pixel, no
 * library. A port of `docs/plans/mockups/bot-ui/source/mice3d/mice.html` (lines 58 to 150); keep the
 * two in step. One draw call renders one face into the current viewport.
 *
 * One change from the reference: `tailD` first returns the distance to a sphere around the tail
 * (the tail turns about P0 and stays within 0.97 of it) when that is over 0.4, the farthest an
 * ambient occlusion sample reaches. Near the tail the exact distance is used, so the picture is the
 * same (at most 11/255 on a few silhouette pixels) and a face draws 20 to 30% faster.
 *
 * Uniforms (set by `faceRenderer.ts` from `facePoses.ts`):
 * - `uRes`, `uOrg`: the viewport size and origin in drawing-buffer pixels.
 * - `uCol`: the body colour; `uAC`: the accessory colour, with `w` = 1 for metal (the crown).
 * - `uAcc`: the accessory index (`BOT_ACCESSORIES` order).
 * - `uB` (hop, squash, roll, tail), `uH` (yaw, pitch, head roll, left ear),
 *   `uH2` (right ear, left arm, right arm, laptop), `uE` (open, closed, arc, worried),
 *   `uE2` (look x, look y, eye scale, sweat): the pose.
 * - `uV`: camera target height, field of view, samples per axis (1 or 2), and 1 to drop the whiskers.
 * - `uK`: the kind (0 mouse, 1 Mousse) and the eye shape (`BOT_EYES` order).
 *
 * The Mousse kind is the app logo as a character: the same head and face, no ears, whiskers, nose,
 * arms, feet or tail; the top tapers into the logo's curled whip (it wags with the tail value), and
 * it sits in a goblet (bowl, stem and foot) in a deeper shade of its colour.
 */

export const MICE_VERTEX_SHADER = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'

export const MICE_UNIFORMS = ['uRes', 'uOrg', 'uCol', 'uB', 'uH', 'uH2', 'uE', 'uE2', 'uV', 'uAC', 'uAcc', 'uK'] as const
export type MiceUniform = (typeof MICE_UNIFORMS)[number]

export const MICE_FRAGMENT_SHADER = `precision highp float;
uniform vec2 uRes,uOrg,uK;uniform vec3 uCol;uniform vec4 uB,uH,uH2,uE,uE2,uV,uAC;uniform float uAcc;
const vec3 HC=vec3(0.,.55,0.),HR=vec3(1.05,.92,.88);
mat2 R(float a){float c=cos(a),s=sin(a);return mat2(c,s,-s,c);}
float sdE(vec3 p,vec3 r){float k0=length(p/r),k1=length(p/(r*r));return k0*(k0-1.)/max(k1,1e-5);}
float sdC(vec3 p,vec3 a,vec3 b,float r){vec3 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.);return length(pa-ba*h)-r;}
float sdB(vec3 p,vec3 b,float r){vec3 q=abs(p)-b;return length(max(q,0.))+min(max(q.x,max(q.y,q.z)),0.)-r;}
float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float arc(vec2 p,float ap,float ra){p.x=abs(p.x);vec2 sc=vec2(sin(ap),cos(ap));return (sc.y*p.x>sc.x*p.y)?length(p-sc*ra):abs(length(p)-ra);}
float zs(float x,float y){return HR.z*sqrt(max(0.,1.-x*x/(HR.x*HR.x)-(y-HC.y)*(y-HC.y)/(HR.y*HR.y)));}
float cyl(vec3 p,float r,float h,float rr){vec2 d=vec2(length(p.xy)-r+rr,abs(p.z)-h+rr);return min(max(d.x,d.y),0.)+length(max(d,0.))-rr;}
float sdRC(vec3 p,vec3 a,vec3 b,float r1,float r2){vec3 ba=b-a;float l2=dot(ba,ba),rr=r1-r2,a2=l2-rr*rr,il2=1./l2;vec3 pa=p-a;float y=dot(pa,ba),z=y-l2;vec3 xv=pa*l2-ba*y;float x2=dot(xv,xv),y2=y*y*l2,z2=z*z*l2,k=sign(rr)*rr*rr*x2;
 if(sign(z)*a2*z2>k)return sqrt(x2+z2)*il2-r2;if(sign(y)*a2*y2<k)return sqrt(x2+y2)*il2-r1;return (sqrt(x2*a2*il2)+y*rr)*il2-r1;}
float whipD(vec3 q){
 vec3 P0=vec3(.04,1.08,0.),P1=vec3(-.2,1.72,0.),P2=vec3(.02,2.06,0.),P3=vec3(.4,2.1,0.);
 if(length(q-vec3(.05,1.6,0.))>1.3)return length(q-vec3(.05,1.6,0.))-1.;float d=1e5;vec3 pv=P0;float rv=.5;
 for(int i=1;i<=12;i++){float u=float(i)/12.,v=1.-u;vec3 c=v*v*v*P0+3.*v*v*u*P1+3.*v*u*u*P2+u*u*u*P3;
  c.xy=P0.xy+R(uB.w*u*.9)*(c.xy-P0.xy);float r=.5*pow(v,1.25)+.012;d=min(d,sdRC(q,pv,c,rv,r));pv=c;rv=r;}
 return d;
}
float gobletD(vec3 b){
 vec3 g=b-vec3(0.,.55,0.);float bowl=max(abs(sdE(g,vec3(1.11,1.,.95)))-.05,g.y+.3);
 float stem=sdRC(b,vec3(0.,-.42,0.),vec3(0.,-1.3,0.),.17,.08);float foot=sdE(b-vec3(0.,-1.4,0.),vec3(.62,.075,.55));
 return smin(smin(bowl,stem,.12),foot,.1);
}
float heart2(vec2 p){p.x=abs(p.x);p.y+=.55;if(p.y+p.x>1.)return length(p-vec2(.25,.75))-.3536;return sqrt(min(dot(p-vec2(0.,1.),p-vec2(0.,1.)),dot(p-.5*max(p.x+p.y,0.),p-.5*max(p.x+p.y,0.))))*sign(p.x-p.y);}
float star2(vec2 p,float r,float rf){const vec2 k1=vec2(.809017,-.587785),k2=vec2(-k1.x,k1.y);p.x=abs(p.x);p-=2.*max(dot(k1,p),0.)*k1;p-=2.*max(dot(k2,p),0.)*k2;p.x=abs(p.x);p.y-=r;
 vec2 ba=rf*vec2(-k1.y,k1.x)-vec2(0.,1.);float h=clamp(dot(p,ba)/dot(ba,ba),0.,r);return length(p-ba*h)*sign(p.y*ba.x-p.x*ba.y);}
float seg2(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.));}
// An open eye of shape k (BOT_EYES order) at eq, opened by op, side s; the pill is the original.
float eyeD(vec3 eq,float op,float es,float s,float k){
 if(k<.5)return sdE(eq,vec3(.155,max(.225*op,.012),.075)*es);
 if(k<1.5)return sdE(eq,vec3(.2,max(.2*op,.012),.075)*es);
 if(k<2.5)return sdE(eq,vec3(.105,max(.105*op,.012),.06)*es);
 if(k<3.5)return sdE(eq,vec3(.115,max(.3*op,.012),.075)*es);
 if(k<4.5)return sdB(eq,vec3(.115,max(.115*op,.006),.025)*es,.06*es);
 float o=max(op,.06),d2;vec2 e=vec2(eq.x,eq.y/o)/es;
 if(k<5.5)d2=heart2(e/.33)*.33;
 else if(k<6.5)d2=star2(e,.26,.45)-.025;
 else d2=min(seg2(e,vec2(s*.11,0.),vec2(-s*.09,.15)),seg2(e,vec2(s*.11,0.),vec2(-s*.09,-.15)))-.048;
 d2*=es*min(1.,o);vec2 w=vec2(d2,abs(eq.z)-.06*es);return min(max(w.x,w.y),0.)+length(max(w,0.));
}
float tailD(vec3 b){
 vec3 P0=vec3(-.32,-1.18,-.34),P1=vec3(-.92,-1.42,-.32),P2=vec3(-1.14,-.8,-.3),P3=vec3(-.8,-.6,-.28);
 float bd=length(b-P0)-1.;if(bd>.4)return bd;float d=1e5;vec3 pv=P0;
 for(int i=1;i<=10;i++){float u=float(i)/10.,v=1.-u;vec3 c=v*v*v*P0+3.*v*v*u*P1+3.*v*u*u*P2+u*u*u*P3;
  c.xy=P0.xy+R(uB.w*u*1.3)*(c.xy-P0.xy);d=min(d,sdC(b,pv,c,mix(.062,.034,u-.05)));pv=c;}
 return min(d,length(b-pv)-.04);
}
float whisk(vec3 q,float s){
 if(length(q.xy-vec2(s*.72,.36))>.36||q.z<.2)return 1e5;
 float d=1e5;
 for(int k=0;k<3;k++){float dy=(float(k)-1.)*.075;vec3 pv=vec3(0.);
  for(int j=0;j<=4;j++){float u=float(j)/4.;float x=s*mix(.6,.9,u),y=mix(.33+dy,.35+dy*1.9,u)+.02*sin(u*3.1416);vec3 c=vec3(x,y,zs(x,y)+.012);
   if(j>0)d=min(d,sdC(q,pv,c,.019));pv=c;}}
 return d;
}
vec2 map(vec3 p){
 p.y-=uB.x;
 float sq=uB.y;vec3 b=p;b.y=(b.y+1.47)/sq-1.47;b.xz*=sqrt(sq);
 b.xy=R(-uB.z)*(b.xy-vec2(0.,-1.47))+vec2(0.,-1.47);
 vec3 q=b-vec3(0.,-.05,0.);q.xz=R(uH.x)*q.xz;q.yz=R(-uH.y)*q.yz;q.xy=R(-uH.z)*q.xy;q+=vec3(0.,-.05,0.);
 bool ms=uK.x>.5;
 float dh=sdE(q-HC,HR),de=1e5;
 if(ms)de=whipD(q);else for(int i=0;i<2;i++){float s=i==0?-1.:1.;float dr=i==0?uH.w:uH2.x;vec3 e=q-vec3(s*.6,1.1,-.12);e.xy=R(s*(.28+dr))*e.xy;de=min(de,sdE(e-vec3(0.,.42,0.),vec3(.58,.58,.16)));}
 float head=smin(dh,de,ms?.26:.06);
 float db=ms?1e5:sdE(b-vec3(0.,-.66,0.),vec3(.64,.6,.53)),dr=1e5,gl=ms?gobletD(b):1e5;
 if(!ms)for(int i=0;i<2;i++){float s=i==0?-1.:1.;float ra=i==0?uH2.y:uH2.z;vec3 sh=vec3(s*.5,-.3,.05);vec3 dir=vec3(s*.17,-.4,.07);dir.xy=R(s*ra)*dir.xy;dir=mix(dir,vec3(-s*.06,-.5+ra*.5,.72),uH2.w);
  db=smin(db,sdC(b,sh,sh+dir,.125),.07);dr=smin(dr,sdE(b-vec3(s*.27,-1.33,.1),vec3(.22,.14,.25)),.02);}
  if(!ms)dr=min(dr,tailD(b));
 bool hood=uAcc>10.5;
 float clay=ms?head:hood?min(head,dr):smin(smin(head,db,.14),dr,.06);
 float blk=1e5;
 float es=uE2.z,op=uE.x;
 for(int i=0;i<2;i++){float s=i==0?-1.:1.;
  float x0=s*.37+uE2.x*.09,y0=.55+uE2.y;vec3 eq=q-vec3(x0,y0,zs(x0,y0)-.035);
  float k=uK.y,hh=k<.5?.225:k<1.5?.2:k<2.5?.105:k<3.5?.3:k<4.5?.175:k<6.5?.3:.2;float dp=eyeD(eq,op,es,s,k);
  float top=max(hh*op,.012)*es*(1.-.3*uE.w)-uE.w*.6*(eq.x*s);dp=-smin(-dp,-(eq.y-top)*.7,.03);
  float py=uE.z>0.?eq.y:-eq.y;float d2=arc(vec2(eq.x,py+.13),1.1,.17)-.045*es;
  vec2 w=vec2(d2,abs(eq.z)-.05);float da=min(max(w.x,w.y),0.)+length(max(w,0.));
  blk=min(blk,mix(dp,da,uE.y));
  if(uV.w<.5&&!ms)blk=min(blk,whisk(q,s));
 }
 if(!ms)blk=min(blk,sdE(q-vec3(0.,.39,.855),vec3(.075,.055,.05)));
 float a=uAcc,ac=hood&&!ms?db:1e5,lap=1e5;
 if(a<.5){}
 else if(a<1.5){ac=max(length(vec2((length(vec2(q.x/1.1,q.y-.55))-.97)*.95,q.z-.06))-.065,.66-q.y);for(int i=0;i<2;i++){float s=i==0?-1.:1.;ac=min(ac,cyl((q-vec3(s*1.07,.55,.04)).zyx,.26,.11,.05));}}
 else if(a<2.5){for(int i=0;i<2;i++){float s=i==0?-1.:1.;vec3 g=q-vec3(s*.37,.55,.9);ac=min(ac,length(vec2(length(g.xy)-.27,g.z))-.037);}ac=min(ac,sdC(q,vec3(-.1,.6,.93),vec3(.1,.6,.93),.03));}
 else if(a<3.5){vec3 bq=q-vec3(.1,1.4,.02);bq.xy=R(.3)*bq.xy;ac=smin(sdE(bq,vec3(.8,.2,.72)),sdE(bq-vec3(0.,.2,0.),vec3(.07,.1,.07)),.04);}
 else if(a<4.5){ac=max(abs(sdE(q-HC,HR*1.03))-.035,abs(q.y-1.)-.075);for(int i=0;i<2;i++){float s=i==0?-1.:1.;ac=min(ac,cyl(q-vec3(s*.3,1.02,zs(.3,1.02)+.06),.19,.08,.04));}}
 else if(a<5.5){ac=max(sdE(q-HC,HR*1.07),1.-q.y);ac=min(ac,max(sdE(q-HC,HR*1.11),abs(q.y-1.04)-.08));ac=smin(ac,length(q-vec3(0.,1.6,0.))-.17,.05);}
 else if(a<6.5){ac=max(sdE(q-HC,HR*1.06),1.02-q.y);vec3 bq=q-vec3(0.,1.04,.8);bq.yz=R(.18)*bq.yz;ac=min(ac,sdE(bq,vec3(.52,.045,.4)));}
 else if(a<7.5){vec3 cq=q-vec3(0.,1.5,0.);cq.xy=R(-.15)*cq.xy;float r=length(cq.xz);ac=max(abs(r-.4)-.045,abs(cq.y-.06)-.13);float sec=6.2832/5.;float an=atan(cq.z,cq.x);an=mod(an+sec*.5,sec)-sec*.5;ac=min(ac,length(vec3(r*cos(an)-.4,cq.y-.24,r*sin(an)))-.075);}
 else if(a<8.5){vec3 t=b-vec3(0.,-.24,.55);for(int i=0;i<2;i++){float s=i==0?-1.:1.;vec3 w=t-vec3(s*.17,0.,0.);w.xy=R(s*.25)*w.xy;ac=min(ac,sdE(w,vec3(.17,.12,.07)));}ac=smin(ac,sdE(t,vec3(.07,.075,.08)),.03);}
 else if(a<9.5){vec3 s0=b-vec3(0.,-.3,0.);ac=(length(vec2(length(s0.xz*vec2(1.,1.18))-.6,s0.y))-.13)*.85;ac=min(ac,sdC(b,vec3(.3,-.35,.55),vec3(.38,-.78,.5),.11));}
 else if(a<10.5){vec3 cq=q-vec3(0.,1.45,0.);vec2 d=vec2(length(cq.xz)-.46,abs(cq.y)-.17);ac=min(max(d.x,d.y),0.)+length(max(d,0.))-.03;ac=smin(ac,length(cq-vec3(-.24,.38,0.))-.3,.08);ac=smin(ac,length(cq-vec3(.24,.38,0.))-.3,.08);ac=smin(ac,length(cq-vec3(0.,.5,0.))-.32,.08);}
 else {ac=min(ac,max(abs(sdE(q-HC,HR*1.1))-.06,-sdE(q-vec3(0.,.5,.8),vec3(.8,.72,.62))));}
 float logo=1e5;if(uH2.w>.01){float L=uH2.w;lap=sdB(b-vec3(0.,-.95,.62),vec3(.36,.018,.22)*L,.012);vec3 s2=b-vec3(0.,-.95,.84);s2.yz=R(.22)*s2.yz;s2.y-=.25*L;lap=min(lap,sdB(s2,vec3(.36,.25,.016)*L,.035));
  vec2 g=s2.xy/max(L,.01);float l2=length(g)-.055;logo=max(l2*L,abs(s2.z-.053*L)-.006);}
 float sw=1e5;if(uE2.w>.01){vec3 s0=q-vec3(.98,1.02-.06*uE2.w,.4);sw=smin(sdE(s0,vec3(.085,.11,.07)*uE2.w),sdE(s0-vec3(0.,.1*uE2.w,0.),vec3(.03,.06,.03)*uE2.w),.05);}
 float d=min(min(min(clay,blk),gl),min(min(sw,logo),min(ac,lap)));
 return vec2(d*.8,d==clay?0.:d==blk?1.:d==sw?2.:d==ac?3.:d==lap?4.:d==gl?6.:5.);
}
vec3 nrm(vec3 p){const vec2 k=vec2(1.,-1.)*.0009;return normalize(k.xyy*map(p+k.xyy).x+k.yyx*map(p+k.yyx).x+k.yxy*map(p+k.yxy).x+k.xxx*map(p+k.xxx).x);}
float ao(vec3 p,vec3 n){float o=0.,s=1.;for(int i=1;i<=5;i++){float h=.02+.07*float(i);o+=(h-map(p+n*h).x/.8)*s;s*=.7;}return clamp(1.-1.6*o,0.,1.);}
vec4 shade(vec2 uv){
 vec3 tg=vec3(0.,uV.x,0.),ro=vec3(0.,uV.x+.9,9.);vec3 fw=normalize(tg-ro),rt=normalize(cross(fw,vec3(0.,1.,0.))),up=cross(rt,fw);
 float th=uV.y/9.;vec3 rd=normalize(fw+uv.x*th*rt+uv.y*th*up);
 vec3 oc=ro-vec3(0.,.35,0.);float bb=dot(oc,rd),cc=dot(oc,oc)-8.5,hh=bb*bb-cc;float t=0.;bool hit=false;
 if(hh>0.){hh=sqrt(hh);t=max(-bb-hh,0.);float tm=-bb+hh;for(int i=0;i<110;i++){float d=map(ro+rd*t).x;if(d<.0012*t){hit=true;break;}t+=d;if(t>tm)break;}}
 if(!hit){if(rd.y<0.){vec3 g=ro+rd*((-1.48-ro.y)/rd.y);float sh=exp(-(g.x*g.x/.45+g.z*g.z/.16))*.42*(1.-clamp(uB.x*1.4,0.,.7));return vec4(0.,0.,0.,sh);}return vec4(0.);}
 vec3 p=ro+rd*t;float m=map(p).y;vec3 n=nrm(p);float o=ao(p,n);
 vec3 L=normalize(vec3(-.55,.75,.65)),F=normalize(vec3(.75,.15,.5));
 float nl=dot(n,L),dif=clamp(nl,0.,1.),wr=pow(nl*.5+.5,1.7),fil=clamp(dot(n,F),0.,1.),fr=pow(1.-clamp(dot(n,-rd),0.,1.),3.);
 float spc=pow(clamp(dot(n,normalize(L-rd)),0.,1.),m>.5?36.:12.);
 vec3 col;
 if(m<.5){vec3 a=pow(uCol,vec3(2.2));if(uK.x>.5)a=mix(a*.82,mix(a,vec3(1.),.38),smoothstep(-.2,2.,p.y-uB.x));col=a*(.16+1.0*wr)*mix(.5,1.,o)+a*fil*.14+.05*spc*dif+a*fr*.3+a*a*.15*(1.-dif)*o;col+=vec3(.55,.7,1.)*a*uH2.w*.45*clamp(dot(n,normalize(vec3(0.,-.5,1.))),0.,1.)*smoothstep(-.4,.2,p.y-uB.x);}
 else if(m<1.5){col=vec3(.02)*(.5+wr)*mix(.6,1.,o)+.3*spc*dif*o+vec3(.07)*fr*o;}
 else if(m<2.5){vec3 a=vec3(.5,.78,1.);col=a*(.3+.7*wr)+.5*spc;}
 else if(m<3.5){vec3 a=pow(uAC.rgb,vec3(2.2));float sp2=pow(clamp(dot(n,normalize(L-rd)),0.,1.),uAC.w>.5?50.:20.);
  col=a*(.14+.9*wr)*mix(.55,1.,o)+a*fil*.12+(uAC.w>.5?a*1.4*sp2+a*fr*.5:vec3(.12)*sp2*dif)+vec3(.05)*fr*o;}
 else if(m<4.5){vec3 a=vec3(.05,.052,.06);col=a*(.3+.9*wr)*mix(.6,1.,o)+.28*pow(clamp(dot(n,normalize(L-rd)),0.,1.),40.)+vec3(.12)*fr;}
 else if(m<5.5){col=vec3(.8,.9,1.);}
 else{vec3 a=pow(uCol*.62+vec3(.03,.02,.06),vec3(2.2));float s2=pow(clamp(dot(n,normalize(L-rd)),0.,1.),48.);col=a*(.18+.95*wr)*mix(.55,1.,o)+a*fil*.15+.22*s2+a*fr*.6+vec3(.04)*fr;}
 return vec4(pow(col,vec3(1./2.2)),1.);
}
void main(){vec2 fc=gl_FragCoord.xy-uOrg;vec4 c=vec4(0.);float n=uV.z;
 for(int j=0;j<2;j++)for(int i=0;i<2;i++){if(float(i)>=n||float(j)>=n)continue;vec2 o=(vec2(float(i),float(j))+.5)/n-.5;c+=shade(((fc+o)/uRes)*2.-1.);}
 gl_FragColor=c/(n*n);}
`
