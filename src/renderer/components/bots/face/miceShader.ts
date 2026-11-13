/**
 * The bot face fragment shader (bot-ui §4.3): signed distance fields ray-marched per pixel, no
 * library. `docs/plans/mockups/bot-ui/source/mice3d/mice.html` runs the same shader; keep the two in
 * step. One draw call renders one face into the current viewport.
 *
 * For speed, `tailD` first returns the distance to a sphere around the tail
 * (the tail turns about P0 and stays within 0.97 of it) when that is over 0.4, the farthest an
 * ambient occlusion sample reaches. Near the tail the exact distance is used, so the picture is the
 * same (at most 11/255 on a few silhouette pixels) and a face draws 20 to 30% faster.
 *
 * Compile cost. On Windows, Chromium runs WebGL through ANGLE's Direct3D 11 backend, which hands this
 * shader to Microsoft's FXC. FXC inlines every function call and its time grows faster than linearly
 * with the straight-line code that results (about the 1.7th power of the size), and every face shows the
 * flat fallback until it ends. So count call sites, not loop trips: a loop body compiles about once
 * however many trips it has. `node scripts/face-shader-cost.mjs` prints the size with every call inlined:
 * 708 statements, from 2,332 with three `map` call sites and 11,019 with seven. Keep it that way:
 * - `map` has one call site: one loop in `shade` runs the march, the normal's four taps and the
 *   occlusion's five. The march carries the material out, so nothing calls `map` again for it.
 * - `accD` has one call site in `map`: each character picks its accessory frame first. The laptop and
 *   sweat drop are likewise built once in either character's frame.
 * - The Mousse's eyes are painted by `shade` where the view ray crosses them, not modelled in `map`.
 * - `toP`/`toQ` have one call site outside `map`: one loop gives the colour's and eyes' frames and runs
 *   the glass march and its six normal taps.
 * - `hk` (the head's knots) has one call site in a 4-trip loop; `gR`, the stem's cones, the tail's
 *   and whiskers' segments and each pair of sides are loops round one call.
 * - New repeated work goes in a loop around one call, not in several calls. GLSL ES 1.00 loops need
 *   constant bounds, and deep nests of constant loops can be unrolled; keep nests shallow.
 * - A quick compile on a Mac (Metal) says nothing about Windows, which is about ten times slower.
 * - Run time: check the GPU time per face against the previous shader. On Metal, writing globals
 *   inside `map`, sharing one eye loop between the characters and running the glass march inside the
 *   `map` loop each cost 5 to 15%, so they are not done.
 * Pixel identity with the shader before #1072 is no longer required. A change may move shading by a few
 * 255ths (march steps land differently) and soft edges by more on single pixels, as long as the faces
 * look the same: silhouettes, eye and accessory shapes and the glass edge must not visibly change.
 *
 * Uniforms (set by `faceRenderer.ts` from `facePoses.ts`):
 * - `uRes`, `uOrg`: the viewport size and origin in drawing-buffer pixels.
 * - `uCol`: the body colour; `uAC`: the accessory colour, with `w` = 1 for metal (the crown).
 * - `uAcc`: the accessory index (`BOT_ACCESSORIES` order).
 * - `uB` (hop, squash, roll, tail), `uH` (yaw, pitch, head roll, left ear),
 *   `uH2` (right ear, left arm, right arm, laptop), `uE` (open, closed, arc, worried),
 *   `uE2` (look x, look y, eye scale, sweat): the pose.
 * - `uV`: camera target height, field of view, samples per axis (1 or 2), and 1 to drop the whiskers.
 * - `uK`: the kind (0 mouse, 1 Mousse), the eye shape (`BOT_EYES` order), and 1 for white eyes (the
 *   Mousse picks black or white eyes to contrast with its colour).
 *
 * The Mousse (kind 1) is the app logo as a character, built in the logo's own units (100 logo units
 * = 1, the foot at 0) and scaled into the mouse's frame by `MS`. Its mousse is one round body whose
 * top narrows, with rounded shoulders and concave sides, into the logo's curled whip; the whip bends
 * with the tail value. It stands in a clear goblet: the bowl is drawn over the scene as a thin shell
 * that is nearly clear face-on and solid at its edges (like the logo's outline), with a solid rim,
 * stem and foot. Its eyes are flat shapes on the front of the glass where the logo's `< >` are,
 * painted where the view ray crosses them. It is shaded flat, in two tones, with the logo's gradient:
 * light at the top, deep at the bottom.
 */

export const MICE_VERTEX_SHADER = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'

export const MICE_UNIFORMS = ['uRes', 'uOrg', 'uCol', 'uB', 'uH', 'uH2', 'uE', 'uE2', 'uV', 'uAC', 'uAcc', 'uK'] as const
export type MiceUniform = (typeof MICE_UNIFORMS)[number]

export const MICE_FRAGMENT_SHADER = `precision highp float;
uniform vec2 uRes,uOrg;uniform vec3 uCol,uK;uniform vec4 uB,uH,uH2,uE,uE2,uV,uAC;uniform float uAcc;
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
float heart2(vec2 p){p.x=abs(p.x);p.y+=.55;if(p.y+p.x>1.)return length(p-vec2(.25,.75))-.3536;vec2 m=.5*max(p.x+p.y,0.)*vec2(1.);return sqrt(min(dot(p-vec2(0.,1.),p-vec2(0.,1.)),dot(p-m,p-m)))*sign(p.x-p.y);}
float star2(vec2 p,float r,float rf){const vec2 k1=vec2(.809017,-.587785),k2=vec2(-.809017,-.587785);p.x=abs(p.x);p-=2.*max(dot(k1,p),0.)*k1;p-=2.*max(dot(k2,p),0.)*k2;p.x=abs(p.x);p.y-=r;
 vec2 ba=rf*vec2(-k1.y,k1.x)-vec2(0.,1.);float h=clamp(dot(p,ba)/dot(ba,ba),0.,r);return length(p-ba*h)*sign(p.y*ba.x-p.x*ba.y);}
float seg2(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.));}
float ell2(vec2 p,vec2 r){return (length(p/r)-1.)*min(r.x,r.y);}
// An open eye of shape k (BOT_EYES order) as a 2D distance, opened by op, side s; the pill is the original.
float eye2(vec2 e,float op,float es,float s,float k){
 if(k<3.5){vec2 r=k<.5?vec2(.155,.225):k<1.5?vec2(.2):k<2.5?vec2(.105):vec2(.115,.3);return ell2(e,vec2(r.x,max(r.y*op,.012))*es);}
 if(k<4.5){vec2 q=abs(e)-vec2(.115,max(.115*op,.006))*es;return length(max(q,0.))+min(max(q.x,q.y),0.)-.06*es;}
 float o=max(op,.06),d2;vec2 f=vec2(e.x,e.y/o)/es;
 if(k<5.5)d2=heart2(f/.33)*.33;
 else if(k<6.5)d2=star2(f,.26,.45)-.025;
 else d2=seg2(vec2(f.x,abs(f.y)),vec2(s*.11,0.),vec2(-s*.09,.15))-.048;
 return d2*es*min(1.,o);
}
// Half the height of each open eye shape, for the worried lid.
float eyeHH(float k){return k<.5?.225:k<1.5?.2:k<2.5?.105:k<3.5?.3:k<4.5?.175:k<6.5?.3:.2;}
// The mouse's eye of shape k: the pill is the original ellipsoid; the rest are their 2D shape, extruded.
float eyeD(vec3 eq,float op,float es,float s,float k){
 if(k<.5)return sdE(eq,vec3(.155,max(.225*op,.012),.075)*es);
 vec2 w=vec2(eye2(eq.xy,op,es,s,k),abs(eq.z)-.06*es);return min(max(w.x,w.y),0.)+length(max(w,0.));
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
// The accessory (uAcc) around a head frame q and a body frame b; ac starts as the hood's body.
// The goggles, beanie, cap and hood are shells of the head's ellipsoid scaled by k, sdE(q-HC,HR*k), which is
// K0*(K0-k)/K1 for one pair of lengths; the headphones and goggles end in one pair of cylinders.
float accD(vec3 q,vec3 b,float ac){
 float a=uAcc,K0=1.,K1=1.;
 if(a>3.5&&a<6.5||a>10.5){vec3 hp=q-HC;K0=length(hp/HR);K1=max(length(hp/(HR*HR)),1e-5);}
 if(a<.5){}
 else if(a<1.5){ac=max(length(vec2((length(vec2(q.x/1.1,q.y-.55))-.97)*.95,q.z-.06))-.065,.66-q.y);}
 else if(a<2.5){for(int i=0;i<2;i++){float s=i==0?-1.:1.;vec3 g=q-vec3(s*.37,.55,.9);ac=min(ac,length(vec2(length(g.xy)-.27,g.z))-.037);}ac=min(ac,sdC(q,vec3(-.1,.6,.93),vec3(.1,.6,.93),.03));}
 else if(a<3.5){vec3 bq=q-vec3(.1,1.4,.02);bq.xy=R(.3)*bq.xy;ac=smin(sdE(bq,vec3(.8,.2,.72)),sdE(bq-vec3(0.,.2,0.),vec3(.07,.1,.07)),.04);}
 else if(a<4.5){ac=max(abs(K0*(K0-1.03)/K1)-.035,abs(q.y-1.)-.075);}
 else if(a<5.5){ac=max(K0*(K0-1.07)/K1,1.-q.y);ac=min(ac,max(K0*(K0-1.11)/K1,abs(q.y-1.04)-.08));ac=smin(ac,length(q-vec3(0.,1.6,0.))-.17,.05);}
 else if(a<6.5){ac=max(K0*(K0-1.06)/K1,1.02-q.y);vec3 bq=q-vec3(0.,1.04,.8);bq.yz=R(.18)*bq.yz;ac=min(ac,sdE(bq,vec3(.52,.045,.4)));}
 else if(a<7.5){vec3 cq=q-vec3(0.,1.5,0.);cq.xy=R(-.15)*cq.xy;float r=length(cq.xz);ac=max(abs(r-.4)-.045,abs(cq.y-.06)-.13);float sec=6.2832/5.;float an=atan(cq.z,cq.x);an=mod(an+sec*.5,sec)-sec*.5;ac=min(ac,length(vec3(r*cos(an)-.4,cq.y-.24,r*sin(an)))-.075);}
 else if(a<8.5){vec3 t=b-vec3(0.,-.24,.55);for(int i=0;i<2;i++){float s=i==0?-1.:1.;vec3 w=t-vec3(s*.17,0.,0.);w.xy=R(s*.25)*w.xy;ac=min(ac,sdE(w,vec3(.17,.12,.07)));}ac=smin(ac,sdE(t,vec3(.07,.075,.08)),.03);}
 else if(a<9.5){vec3 s0=b-vec3(0.,-.3,0.);ac=(length(vec2(length(s0.xz*vec2(1.,1.18))-.6,s0.y))-.13)*.85;ac=min(ac,sdC(b,vec3(.3,-.35,.55),vec3(.38,-.78,.5),.11));}
 else if(a<10.5){vec3 cq=q-vec3(0.,1.45,0.);vec2 d=vec2(length(cq.xz)-.46,abs(cq.y)-.17);ac=min(max(d.x,d.y),0.)+length(max(d,0.))-.03;ac=smin(ac,length(cq-vec3(-.24,.38,0.))-.3,.08);ac=smin(ac,length(cq-vec3(.24,.38,0.))-.3,.08);ac=smin(ac,length(cq-vec3(0.,.5,0.))-.32,.08);}
 else {ac=min(ac,max(abs(K0*(K0-1.1)/K1)-.06,-sdE(q-vec3(0.,.5,.8),vec3(.8,.72,.62))));}
 if(a>.5&&a<1.5||a>3.5&&a<4.5){bool ph=a<1.5;for(int i=0;i<2;i++){float s=i==0?-1.:1.;
  ac=min(ac,cyl(ph?(q-vec3(s*1.07,.55,.04)).zyx:q-vec3(s*.3,1.02,zs(.3,1.02)+.06),ph?.26:.19,ph?.11:.08,ph?.05:.04));}}
 return ac;
}
// ---------- the Mousse (kind 1), in the logo's units: 100 logo units = 1, the foot at y = 0 ----------
const float MS=.7;
// The size of one pixel in logo units, set per pixel by shade: thin parts (the glass, the rim) stay at least this wide.
float gPx=.02;
// The view ray in the head frame (Q), set by shade, for painting the eyes where the ray crosses them.
vec3 gRd=vec3(0.,0.,-1.);
// The pose (hop, squash, roll) as for the mouse; P is the logo frame, Q also turns with the head (yaw, a little pitch).
vec3 toP(vec3 p){p.y-=uB.x;float sq=uB.y;p.y=(p.y+1.47)/sq-1.47;p.xz*=sqrt(sq);p.xy=R(-uB.z)*(p.xy-vec2(0.,-1.47))+vec2(0.,-1.47);return vec3(p.x,p.y+1.48,p.z)/MS;}
vec3 toQ(vec3 P){vec3 Q=P-vec3(0.,2.6,0.);Q.xz=R(uH.x)*Q.xz;Q.yz=R(-uH.y*.5)*Q.yz;return Q+vec3(0.,2.6,0.);}
// The head, read off the 3D model: its middle (x) and half-width (y) at each height from y 3.45 to the tip,
// as a cubic Hermite curve through 27 knots. It narrows from the bowl's width into the logo's hooked curl.
// hk(i): knot i's middle and half-width (xy) and their slopes (zw); hy(i): its height; hs(y): the segment
// (knot i to i + 1) that holds height y.
vec4 hk(float i){
 if(i<.5)return vec4(0.,1.3375,.0743,-.6092);if(i<1.5)return vec4(.0056,1.2918,.1337,-.5975);if(i<2.5)return vec4(.02,1.2478,.24,-.6526);if(i<3.5)return vec4(.0416,1.1939,.3202,-.8408);
 if(i<4.5)return vec4(.0681,1.1217,.3732,-1.1284);if(i<5.5)return vec4(.0976,1.0246,.4001,-1.4991);if(i<6.5)return vec4(.1281,.8969,.4028,-1.8704);if(i<7.5)return vec4(.158,.7441,.3728,-1.8385);
 if(i<8.5)return vec4(.184,.6211,.3896,-1.2215);if(i<9.5)return vec4(.2164,.5608,.2864,-.7382);if(i<10.5)return vec4(.227,.5104,.0169,-.6135);if(i<11.5)return vec4(.2189,.4688,-.1478,-.5183);
 if(i<12.5)return vec4(.2048,.4326,-.349,-.5225);if(i<13.5)return vec4(.1666,.3904,-.544,-.595);if(i<14.5)return vec4(.1232,.3434,-.4964,-.6804);if(i<15.5)return vec4(.0921,.2884,-.2985,-.7476);
 if(i<16.5)return vec4(.0784,.2312,-.0815,-.7349);if(i<17.5)return vec4(.0799,.1781,.1189,-.6347);if(i<18.5)return vec4(.0963,.136,.3206,-.4411);if(i<19.5)return vec4(.128,.112,.5298,-.255);
 if(i<20.5)return vec4(.1757,.0978,.6995,-.1668);if(i<21.5)return vec4(.2155,.0911,.8533,-.1167);if(i<22.5)return vec4(.2525,.0873,.9804,-.1758);if(i<23.5)return vec4(.2841,.0788,1.0798,-.5082);
 if(i<24.5)return vec4(.3119,.0593,.986,-.8956);if(i<25.5)return vec4(.3285,.0385,.4764,-1.695);return vec4(.3286,0.,.0096,-2.5683);}
float hy(float i){return i<20.5?3.45+.075*i:i<21.5?5.:i<22.5?5.04:i<23.5?5.07:i<24.5?5.095:i<25.5?5.115:5.13;}
float hs(float y){return y<4.95?floor((y-3.45)/.075):20.+float(y>=5.)+float(y>=5.04)+float(y>=5.07)+float(y>=5.095)+float(y>=5.115);}
// The whole mousse: round slices about the bent middle, a little flatter front to back near the top;
// above y 3.95 it bends with the tail value. The bend's pivot is the head's middle at 3.95 (in float32) and
// the middle above 5.13 is the last knot's, both written out. The middle and radius at y and either side of
// it (0.02 away, which crosses at most one knot) come from the four knots round y's segment, read once in a
// 4-trip loop round one hk call and only above the bowl; below y 3.45 the bowl's round bottom.
float mousseD(vec3 Q){
 vec2 pv=vec2(.148343742,3.95);float s=smoothstep(3.95,5.13,Q.y);Q.xy=pv+R(-uB.w*.6*s*sqrt(s))*(Q.xy-pv);
 float y=clamp(Q.y,1.41,5.13),k=max(hs(max(y,3.45))-1.,0.);vec4 c0=vec4(0.),c1=c0,c2=c0,c3=c0;
 if(y>3.43)for(int i=0;i<4;i++){vec4 c=hk(min(k+float(i),26.));if(i==0)c0=c;else if(i==1)c1=c;else if(i==2)c2=c;else c3=c;}
 vec2 m=vec2(0.),hi=m,lo=m;
 for(int i=0;i<3;i++){float yv=i==0?y:i==1?min(y+.02,5.13):max(y-.02,1.41);vec2 v;
  if(yv<3.45){float u=(2.85-yv)/1.44,z=(yv-2.85)/.6;v=vec2(0.,yv<2.85?1.42*pow(max(0.,1.-pow(u,2.6)),.385):1.42-.09*z*z);}
  else{float j=hs(yv),e=j-k,a=hy(j),w=hy(j+1.)-a,t=(yv-a)/w,t2=t*t,t3=t2*t;vec4 p0=e<.5?c0:e<1.5?c1:c2,p1=e<.5?c1:e<1.5?c2:c3;
   v=(2.*t3-3.*t2+1.)*p0.xy+(t3-2.*t2+t)*w*p0.zw+(3.*t2-2.*t3)*p1.xy+(t3-t2)*w*p1.zw;}
  if(i==0)m=v;else if(i==1)hi=v;else lo=v;}
 float dr=(hi.y-lo.y)/.04,dc=(hi.x-lo.x)/.04,zs=1.-.1*smoothstep(4.2,4.8,y);
 float rho=length(vec2(Q.x-m.x,Q.z/zs)),d=(rho-max(m.y,0.))*zs/sqrt(1.+min(dr*dr,25.)+dc*dc);
 if(Q.y<1.41)d=max(d,length(vec2(rho,Q.y-1.41)));
 if(Q.y>5.13)d=length(Q-vec3(.3286,5.13,0.));
 return d;
}
// The glass bowl's profile (radius at height), and its shell: the distance to that curve, turned about the axis.
// The profile at y and either side of it is read in a 3-trip loop round one gR call.
float gR(float y){if(y<2.85){float u=(2.85-y)/1.49;return 1.52*pow(max(0.,1.-pow(u,2.6)),.385);}float v=sin(clamp((y-2.85)/1.26,0.,1.)*1.5708);return 1.52-.16*v*v;}
float gD(vec3 Q){vec2 q=vec2(length(Q.xz),Q.y);
 float d=min(seg2(q,vec2(0.,1.36),vec2(.55,1.41)),seg2(q,vec2(.55,1.41),vec2(1.,1.57)));
 float y=clamp(q.y,1.57,4.11),g0=0.,g1=0.,g2=0.;
 for(int i=0;i<3;i++){float g=gR(i==0?y:i==1?min(y+.02,4.11):max(y-.02,1.57));if(i==0)g0=g;else if(i==1)g1=g;else g2=g;}
 float dr=(g1-g2)/.04,e=q.y>4.11?length(q-vec2(1.36,4.11)):q.y<1.57?length(q-vec2(1.,1.57)):abs(q.x-g0)/sqrt(1.+dr*dr);
 return min(d,e)-max(.014,.55*gPx);}
// The foot, then the stem's three cones in one loop: the base (blended), the shaft and the top (blended).
float stemM(vec3 P){float d=sdE(P-vec3(0.,.04,0.),vec3(.87,.045,.87));
 for(int i=0;i<3;i++){float y0=i==0?.1:i==1?.32:1.1,y1=i==0?.32:i==1?1.1:1.37,c=sdRC(P,vec3(0.,y0,0.),vec3(0.,y1,0.),i==0?.3:i==1?.13:.105,i==0?.13:i==1?.105:.24);
  d=i==1?min(d,c):smin(d,c,i==0?.06:.04);}
 return d;}
// The eyes: flat shapes on the front of the glass where the logo's < > are, in any of the shapes and feelings.
// They are not part of map(): shade paints them from the distance to their outline where the view ray (gRd)
// crosses their plane, over whatever the ray hit behind that plane (w <= .012, the old slab's front).
float eyesM(vec3 Q){
 float blk=1e5,es=uE2.z,op=uE.x;
 for(int i=0;i<2;i++){float s=i==0?-1.:1.;float a=s*.255+uE2.x*.22,ey=2.2+uE2.y*1.2;vec3 n=vec3(sin(a),0.,cos(a)),tg=vec3(cos(a),0.,-sin(a)),e=n*1.465+vec3(0.,ey,0.);
  vec3 r=Q-e;float w=dot(r,n);r-=gRd*w/dot(gRd,n);vec2 f=vec2(dot(r,tg),r.y)/1.35;
  float d2=eye2(f,op,es,s,uK.y);float top=max(eyeHH(uK.y)*op,.012)*es*(1.-.3*uE.w)-uE.w*.6*(f.x*s);d2=-smin(-d2,-(f.y-top)*.7,.03);
  float py=uE.z>0.?f.y:-f.y;float dc=arc(vec2(f.x,py+.13),1.1,.17)-.045*es;d2=mix(d2,dc,uE.y)*1.35;
  blk=min(blk,w>.012?1e5:d2);}
 return blk;
}
// The logo's mousse gradient (light at the top, deep at the bottom) on the bot's colour, by height in the logo frame.
vec3 mousseCol(float y){vec3 B=uCol,W=vec3(1.),D=uCol*vec3(.3,.26,.38);float t=(3.7-y)/2.81;
 vec3 c=t<.154?mix(mix(B,W,.82),mix(B,W,.6),t/.154):t<.357?mix(mix(B,W,.6),mix(B,W,.2),(t-.154)/.203):t<.466?mix(mix(B,W,.2),B,(t-.357)/.109):t<.553?mix(B,B*.86,(t-.466)/.087):t<.75?mix(B*.86,mix(B,D,.6),(t-.553)/.197):mix(mix(B,D,.6),mix(B,D,.72),clamp((t-.75)/.25,0.,1.));
 vec3 w=mix(mix(B,W,.66),mix(B,W,.5),smoothstep(4.6,5.1,y));return mix(c,w,smoothstep(3.5,3.9,y));}
// The scene: x the distance, y the material. Each character builds its own parts and the frames its accessory,
// laptop and sweat drop sit in; then one copy of each of those serves both.
vec2 map(vec3 p){
 bool mk=uK.x>.5;
 float clay,blk,gl=1e5,rim=1e5,ac0=1e5,a=uAcc,hat=0.,lap=1e5,logo=1e5,sw=1e5;vec3 aq,ab,lb,sq;
 if(mk){
  vec3 P=toP(p),Q=toQ(P);
  clay=mousseD(Q);
  // The Mousse's eyes are painted by shade, not modelled, so it has no black parts here.
  gl=stemM(P);rim=length(vec2(length(Q.xz)-1.36,Q.y-4.11))-max(.024,.5*gPx);blk=1e5;
  // Accessories in the mouse's frames, placed on the Mousse: hats (beret, beanie, cap, crown, chef's hat)
  // tilted on its left shoulder beside the curl, headphones, goggles and hood around its top, glasses on
  // its eyes, the bow tie, scarf and laptop by the stem.
  float hb=uAcc<3.5?1.22:uAcc<6.5?1.:uAcc<7.5?1.37:1.28;vec2 hx=R(.38)*(Q.xy-vec2(-.5,4.12))/.85;vec3 qh=vec3(hx.x,hx.y+hb,(Q.z-.1)/.85);
  vec3 qt=(Q-vec3(0.,3.55,0.))*.78+HC,qf=vec3(Q.x*.95,(Q.y-2.2)*.95+.55,(Q.z-1.5)*.95+.9),bn=(P-vec3(0.,1.15,0.))*1.4+vec3(0.,-.3,0.);
  hat=float(a>2.5&&a<3.5||a>4.5&&a<7.5||a>9.5&&a<10.5);
  aq=hat>.5?qh:a>1.5&&a<2.5?qf:qt;ab=a>7.5&&a<9.5?bn+vec3(0.,0.,a<8.5?.3:0.):bn;
  lb=bn;sq=qt;
 }else{
  p.y-=uB.x;
  float sq0=uB.y;vec3 b=p;b.y=(b.y+1.47)/sq0-1.47;b.xz*=sqrt(sq0);
  b.xy=R(-uB.z)*(b.xy-vec2(0.,-1.47))+vec2(0.,-1.47);
  vec3 q=b-vec3(0.,-.05,0.);q.xz=R(uH.x)*q.xz;q.yz=R(-uH.y)*q.yz;q.xy=R(-uH.z)*q.xy;q+=vec3(0.,-.05,0.);
  float dh=sdE(q-HC,HR),de=1e5;
  for(int i=0;i<2;i++){float s=i==0?-1.:1.;float dr=i==0?uH.w:uH2.x;vec3 e=q-vec3(s*.6,1.1,-.12);e.xy=R(s*(.28+dr))*e.xy;de=min(de,sdE(e-vec3(0.,.42,0.),vec3(.58,.58,.16)));}
  float head=smin(dh,de,.06);
  float db=sdE(b-vec3(0.,-.66,0.),vec3(.64,.6,.53)),dr=1e5;
  for(int i=0;i<2;i++){float s=i==0?-1.:1.;float ra=i==0?uH2.y:uH2.z;vec3 sh=vec3(s*.5,-.3,.05);vec3 dir=vec3(s*.17,-.4,.07);dir.xy=R(s*ra)*dir.xy;dir=mix(dir,vec3(-s*.06,-.5+ra*.5,.72),uH2.w);
   db=smin(db,sdC(b,sh,sh+dir,.125),.07);dr=smin(dr,sdE(b-vec3(s*.27,-1.33,.1),vec3(.22,.14,.25)),.02);}
  dr=min(dr,tailD(b));
  bool hood=uAcc>10.5;
  clay=hood?min(head,dr):smin(smin(head,db,.14),dr,.06);
  blk=1e5;
  float es=uE2.z,op=uE.x;
  for(int i=0;i<2;i++){float s=i==0?-1.:1.;
   float x0=s*.37+uE2.x*.09,y0=.55+uE2.y;vec3 eq=q-vec3(x0,y0,zs(x0,y0)-.035);
   float dp=eyeD(eq,op,es,s,uK.y);
   float top=max(eyeHH(uK.y)*op,.012)*es*(1.-.3*uE.w)-uE.w*.6*(eq.x*s);dp=-smin(-dp,-(eq.y-top)*.7,.03);
   float py=uE.z>0.?eq.y:-eq.y;float d2=arc(vec2(eq.x,py+.13),1.1,.17)-.045*es;
   vec2 w=vec2(d2,abs(eq.z)-.05);float da=min(max(w.x,w.y),0.)+length(max(w,0.));
   blk=min(blk,mix(dp,da,uE.y));
   if(uV.w<.5)blk=min(blk,whisk(q,s));
  }
  blk=min(blk,sdE(q-vec3(0.,.39,.855),vec3(.075,.055,.05)));
  lb=b;sq=q;aq=q;ab=b;ac0=hood?db:1e5;
 }
 float ls=mk?1.4:1.;
 if(uH2.w>.01){float L=uH2.w;lap=sdB(lb-vec3(0.,-.95,.62),vec3(.36,.018,.22)*L,.012);vec3 s2=lb-vec3(0.,-.95,.84);s2.yz=R(.22)*s2.yz;s2.y-=.25*L;lap=min(lap,sdB(s2,vec3(.36,.25,.016)*L,.035));
  vec2 g=s2.xy/max(L,.01);float l2=length(g)-.055;logo=max(l2*L,abs(s2.z-.053*L)-.006)/ls;lap/=ls;}
 if(uE2.w>.01){vec3 s0=sq-vec3(.98,1.02-.06*uE2.w,.4);sw=smin(sdE(s0,vec3(.085,.11,.07)*uE2.w),sdE(s0-vec3(0.,.1*uE2.w,0.),vec3(.03,.06,.03)*uE2.w),.05)/(mk?.78:1.);}
 float ac=accD(aq,ab,ac0);
 // On the Mousse the accessory is scaled back from the mouse's frame it was built in.
 if(mk)ac=hat>.5?ac*.85:a>1.5&&a<2.5?ac/.95:a>7.5&&a<9.5?ac/1.4:ac/.78;
 // The mouse has no glass (gl and rim stay 1e5, far beyond any part), so one material chain serves both.
 float d=min(min(min(clay,blk),min(gl,rim)),min(min(sw,logo),min(ac,lap)));
 return vec2(mk?d*MS*.8:d*.8,d==clay?0.:d==blk?1.:d==sw?2.:d==ac?3.:d==lap?4.:d==gl?6.:d==rim?7.:5.);
}
vec4 shade(vec2 uv){
 float vx=uV.x;if(uK.x>.5&&vx>.5)vx=.6;vec3 tg=vec3(0.,vx,0.),ro=vec3(0.,vx+.9,9.);vec3 fw=normalize(tg-ro),rt=normalize(cross(fw,vec3(0.,1.,0.))),up=cross(rt,fw);
 float th=uV.y/9.*(uK.x>.5&&uV.x>.5?1.16:1.);vec3 rd=normalize(fw+uv.x*th*rt+uv.y*th*up);
 vec3 oc=ro-vec3(0.,.35,0.);float bb=dot(oc,rd),cc=dot(oc,oc)-8.5,hh=bb*bb-cc;float t=0.;bool hit=false;float pxa=th*2./uRes.y,tol=min(.0012,.3*pxa),md=1e5,mt=0.,cov=1.;gPx=pxa*9./MS;
 // One loop calls map() for everything: the march (phase 0, up to 110 trips), the normal's four taps (1: each
 // adds its offset times its distance) and the occlusion's five (2). The march keeps the material of the point
 // it stops at.
 vec3 p=vec3(0.),n=vec3(0.);float m=0.,mm=0.,o=0.,os=1.;
 if(hh>0.){hh=sqrt(hh);t=max(-bb-hh,0.);float tm=-bb+hh;int ph=0,k=0;
  for(int i=0;i<119;i++){vec3 x=ro+rd*t,e=vec3(k==0||k==3?1.:-1.,k>1?1.:-1.,k==1||k==3?1.:-1.)*.0009;float h=.02+.07*float(k+1);
   if(ph==1)x=p+e;else if(ph==2)x=p+n*h;
   vec2 dm=map(x);float d=dm.x;
   if(ph==0){bool end=false;if(d<md*t){md=d/t;mt=t;mm=dm.y;}if(d<tol*t){hit=true;m=dm.y;end=true;}else{t+=d;end=t>tm||i==109;}
    // A ray that passes within a pixel of the surface covers part of the pixel: soft edges at no extra cost.
    if(end){if(!hit&&md<tol+.8*pxa){hit=true;t=mt;cov=clamp(1.-(md-tol)/(.8*pxa),0.,1.);m=mm;}
     if(!hit)break;p=ro+rd*t;ph=1;}}
   else if(ph==1){n+=e*d;k++;if(k==4){n=normalize(n);ph=2;k=0;}}
   else{o+=(h-d/.8)*os;os*=.7;k++;if(k==5)break;}}}
 o=clamp(1.-1.6*o,0.,1.);
 bool mk=uK.x>.5;vec4 bg=vec4(0.);
 if((!hit||cov<1.)&&rd.y<0.){vec3 g=ro+rd*((-1.48-ro.y)/rd.y);bg=vec4(0.,0.,0.,exp(-(g.x*g.x/.45+g.z*g.z/.16))*.42*(1.-clamp(uB.x*1.4,0.,.7)));}
 // One loop round one toQ(toP()) call for the Mousse's frames: on a hit, first the point (k -2: its height for the
 // colour, its head frame for the eyes) and a point further along the ray (k -1: the view ray in the head frame);
 // then the glass's own march (k 0, up to 64 steps) and its normal's six taps (k 1 to 6).
 float ga=0.,py=0.;vec3 gc=pow(uCol*.76,vec3(2.2)),qp=vec3(0.);
 if(mk&&hh>0.){float tg=max(-bb-hh,0.),te=hit?t:-bb+hh;vec3 ng=vec3(0.);int k=hit?-2:0,gi=0;
  for(int i=0;i<72;i++){vec3 q=ro+rd*tg,ax=vec3(k==1||k==2?1.:0.,k==3||k==4?1.:0.,k>4?1.:0.);float sg=k==2||k==4||k==6?-1.:1.;
   if(k==-2)q=p;else if(k==-1)q=p+rd;else if(k>0)q+=ax*(.002*sg);
   vec3 P=toP(q),Q=toQ(P);
   if(k==-2){py=P.y;qp=Q;k=-1;}
   else if(k==-1){gRd=normalize(Q-qp);k=0;}
   else{float v=gD(Q);
    if(k==0){float d=v*MS;gi++;if(d<.0008*tg)k=1;else{tg+=d*.9;if(tg>te||gi==64)break;}}
    else{ng+=ax*(v*sg);k++;if(k==7){ng=normalize(ng);ga=.07+.93*smoothstep(.72,.86,1.-abs(dot(ng,rd)));break;}}}}}
 if(!hit){if(ga>0.)return vec4(pow(gc,vec3(1./2.2))*ga,ga+bg.a*(1.-ga));return bg;}
 vec3 L=normalize(vec3(-.55,.75,.65)),F=normalize(vec3(.75,.15,.5));
 float nl=dot(n,L),dif=clamp(nl,0.,1.),wr=pow(nl*.5+.5,1.7),fil=clamp(dot(n,F),0.,1.),fr=pow(1.-clamp(dot(n,-rd),0.,1.),3.);
 float spc=pow(clamp(dot(n,normalize(L-rd)),0.,1.),m>.5?36.:12.);
 vec3 col;
 float band=mix(.8,1.,smoothstep(-.06,.06,dot(n,L)+.12));
 if(mk&&m<1.5){col=pow(mousseCol(py),vec3(2.2))*(m>.5?1.:band);}
 else if(mk&&m>5.5){col=pow(m<6.5?uCol*.76:mix(uCol,vec3(1.),.35),vec3(2.2))*band;}
 else if(m<.5){vec3 a=pow(uCol,vec3(2.2));col=a*(.16+1.0*wr)*mix(.5,1.,o)+a*fil*.14+.05*spc*dif+a*fr*.3+a*a*.15*(1.-dif)*o;col+=vec3(.55,.7,1.)*a*uH2.w*.45*clamp(dot(n,normalize(vec3(0.,-.5,1.))),0.,1.)*smoothstep(-.4,.2,p.y-uB.x);}
 else if(m<1.5){col=vec3(.02)*(.5+wr)*mix(.6,1.,o)+.3*spc*dif*o+vec3(.07)*fr*o;}
 else if(m<2.5){vec3 a=vec3(.5,.78,1.);col=a*(.3+.7*wr)+.5*spc;}
 else if(m<3.5){vec3 a=pow(uAC.rgb,vec3(2.2));float sp2=pow(clamp(dot(n,normalize(L-rd)),0.,1.),uAC.w>.5?50.:20.);
  col=a*(.14+.9*wr)*mix(.55,1.,o)+a*fil*.12+(uAC.w>.5?a*1.4*sp2+a*fr*.5:vec3(.12)*sp2*dif)+vec3(.05)*fr*o;}
 else if(m<4.5){vec3 a=vec3(.05,.052,.06);col=a*(.3+.9*wr)*mix(.6,1.,o)+.28*pow(clamp(dot(n,normalize(L-rd)),0.,1.),40.)+vec3(.12)*fr;}
 else{col=vec3(.8,.9,1.);}
 if(ga>0.)col=mix(col,gc,ga);
 // The Mousse's eyes are painted where the view ray crosses them, over whatever lies behind them.
 if(mk)col=mix(col,uK.z>.5?vec3(1.):vec3(.004),clamp(.5-eyesM(qp)/(pxa*t/MS),0.,1.));
 return vec4(pow(col,vec3(1./2.2))*cov,cov)+bg*(1.-cov);
}
void main(){vec2 fc=gl_FragCoord.xy-uOrg;vec4 c=vec4(0.);float n=uV.z;
 for(int k=0;k<4;k++){int j=k/2,i=k-j*2;if(float(i)>=n||float(j)>=n)continue;vec2 o=(vec2(float(i),float(j))+.5)/n-.5;c+=shade(((fc+o)/uRes)*2.-1.);}
 gl_FragColor=c/(n*n);}
`
