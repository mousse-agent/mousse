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
 * The Mousse (`mapM`) is the app logo as a character, built in the logo's own units (100 logo units
 * = 1, the foot at 0) and scaled into the mouse's frame by `MS`. Its mousse is one round body whose
 * top narrows, with rounded shoulders and concave sides, into the logo's curled whip; the whip bends
 * with the tail value. It stands in a clear goblet: the bowl is drawn over the scene as a thin shell
 * that is nearly clear face-on and solid at its edges (like the logo's outline), with a solid rim,
 * stem and foot. Its eyes are flat shapes on the front of the glass where the logo's `< >` are. It is
 * shaded flat, in two tones, with the logo's gradient: light at the top, deep at the bottom.
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
 if(k<.5)return ell2(e,vec2(.155,max(.225*op,.012))*es);
 if(k<1.5)return ell2(e,vec2(.2,max(.2*op,.012))*es);
 if(k<2.5)return ell2(e,vec2(.105,max(.105*op,.012))*es);
 if(k<3.5)return ell2(e,vec2(.115,max(.3*op,.012))*es);
 if(k<4.5){vec2 q=abs(e)-vec2(.115,max(.115*op,.006))*es;return length(max(q,0.))+min(max(q.x,q.y),0.)-.06*es;}
 float o=max(op,.06),d2;vec2 f=vec2(e.x,e.y/o)/es;
 if(k<5.5)d2=heart2(f/.33)*.33;
 else if(k<6.5)d2=star2(f,.26,.45)-.025;
 else d2=min(seg2(f,vec2(s*.11,0.),vec2(-s*.09,.15)),seg2(f,vec2(s*.11,0.),vec2(-s*.09,-.15)))-.048;
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
float accD(vec3 q,vec3 b,float ac){
 float a=uAcc;
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
 return ac;
}
// ---------- the Mousse (kind 1), in the logo's units: 100 logo units = 1, the foot at y = 0 ----------
const float MS=.7;
// The pose (hop, squash, roll) as for the mouse; P is the logo frame, Q also turns with the head (yaw, a little pitch).
vec3 toP(vec3 p){p.y-=uB.x;float sq=uB.y;p.y=(p.y+1.47)/sq-1.47;p.xz*=sqrt(sq);p.xy=R(-uB.z)*(p.xy-vec2(0.,-1.47))+vec2(0.,-1.47);return vec3(p.x,p.y+1.48,p.z)/MS;}
vec3 toQ(vec3 P){vec3 Q=P-vec3(0.,2.6,0.);Q.xz=R(uH.x)*Q.xz;Q.yz=R(-uH.y*.5)*Q.yz;return Q+vec3(0.,2.6,0.);}
// The head, read off the 3D model: its middle (x) and half-width (y) at each height from y 3.45 to the tip,
// as a smooth curve through samples. It narrows from the bowl's width into the logo's hooked curl.
vec2 hmM(float y,float a,float b,vec2 p0,vec2 p1,vec2 m0,vec2 m1){float d=b-a,t=(y-a)/d,t2=t*t,t3=t2*t;
 return (2.*t3-3.*t2+1.)*p0+(t3-2.*t2+t)*d*m0+(3.*t2-2.*t3)*p1+(t3-t2)*d*m1;}
vec2 headM(float y){
 if(y<3.525)return hmM(y,3.45,3.525,vec2(0.,1.3375),vec2(.0056,1.2918),vec2(.0743,-.6092),vec2(.1337,-.5975));
 if(y<3.6)return hmM(y,3.525,3.6,vec2(.0056,1.2918),vec2(.02,1.2478),vec2(.1337,-.5975),vec2(.24,-.6526));
 if(y<3.675)return hmM(y,3.6,3.675,vec2(.02,1.2478),vec2(.0416,1.1939),vec2(.24,-.6526),vec2(.3202,-.8408));
 if(y<3.75)return hmM(y,3.675,3.75,vec2(.0416,1.1939),vec2(.0681,1.1217),vec2(.3202,-.8408),vec2(.3732,-1.1284));
 if(y<3.825)return hmM(y,3.75,3.825,vec2(.0681,1.1217),vec2(.0976,1.0246),vec2(.3732,-1.1284),vec2(.4001,-1.4991));
 if(y<3.9)return hmM(y,3.825,3.9,vec2(.0976,1.0246),vec2(.1281,.8969),vec2(.4001,-1.4991),vec2(.4028,-1.8704));
 if(y<3.975)return hmM(y,3.9,3.975,vec2(.1281,.8969),vec2(.158,.7441),vec2(.4028,-1.8704),vec2(.3728,-1.8385));
 if(y<4.05)return hmM(y,3.975,4.05,vec2(.158,.7441),vec2(.184,.6211),vec2(.3728,-1.8385),vec2(.3896,-1.2215));
 if(y<4.125)return hmM(y,4.05,4.125,vec2(.184,.6211),vec2(.2164,.5608),vec2(.3896,-1.2215),vec2(.2864,-.7382));
 if(y<4.2)return hmM(y,4.125,4.2,vec2(.2164,.5608),vec2(.227,.5104),vec2(.2864,-.7382),vec2(.0169,-.6135));
 if(y<4.275)return hmM(y,4.2,4.275,vec2(.227,.5104),vec2(.2189,.4688),vec2(.0169,-.6135),vec2(-.1478,-.5183));
 if(y<4.35)return hmM(y,4.275,4.35,vec2(.2189,.4688),vec2(.2048,.4326),vec2(-.1478,-.5183),vec2(-.349,-.5225));
 if(y<4.425)return hmM(y,4.35,4.425,vec2(.2048,.4326),vec2(.1666,.3904),vec2(-.349,-.5225),vec2(-.544,-.595));
 if(y<4.5)return hmM(y,4.425,4.5,vec2(.1666,.3904),vec2(.1232,.3434),vec2(-.544,-.595),vec2(-.4964,-.6804));
 if(y<4.575)return hmM(y,4.5,4.575,vec2(.1232,.3434),vec2(.0921,.2884),vec2(-.4964,-.6804),vec2(-.2985,-.7476));
 if(y<4.65)return hmM(y,4.575,4.65,vec2(.0921,.2884),vec2(.0784,.2312),vec2(-.2985,-.7476),vec2(-.0815,-.7349));
 if(y<4.725)return hmM(y,4.65,4.725,vec2(.0784,.2312),vec2(.0799,.1781),vec2(-.0815,-.7349),vec2(.1189,-.6347));
 if(y<4.8)return hmM(y,4.725,4.8,vec2(.0799,.1781),vec2(.0963,.136),vec2(.1189,-.6347),vec2(.3206,-.4411));
 if(y<4.875)return hmM(y,4.8,4.875,vec2(.0963,.136),vec2(.128,.112),vec2(.3206,-.4411),vec2(.5298,-.255));
 if(y<4.95)return hmM(y,4.875,4.95,vec2(.128,.112),vec2(.1757,.0978),vec2(.5298,-.255),vec2(.6995,-.1668));
 if(y<5.)return hmM(y,4.95,5.,vec2(.1757,.0978),vec2(.2155,.0911),vec2(.6995,-.1668),vec2(.8533,-.1167));
 if(y<5.04)return hmM(y,5.,5.04,vec2(.2155,.0911),vec2(.2525,.0873),vec2(.8533,-.1167),vec2(.9804,-.1758));
 if(y<5.07)return hmM(y,5.04,5.07,vec2(.2525,.0873),vec2(.2841,.0788),vec2(.9804,-.1758),vec2(1.0798,-.5082));
 if(y<5.095)return hmM(y,5.07,5.095,vec2(.2841,.0788),vec2(.3119,.0593),vec2(1.0798,-.5082),vec2(.986,-.8956));
 if(y<5.115)return hmM(y,5.095,5.115,vec2(.3119,.0593),vec2(.3285,.0385),vec2(.986,-.8956),vec2(.4764,-1.695));
 if(y<5.13)return hmM(y,5.115,5.13,vec2(.3285,.0385),vec2(.3286,0.),vec2(.4764,-1.695),vec2(.0096,-2.5683));
 return vec2(.3286,0.);}
// The mousse's middle and radius at each height: the bowl's round bottom, then the head.
vec2 prM(float y){if(y<3.45){if(y<2.85){float u=(2.85-y)/1.44;return vec2(0.,1.42*pow(max(0.,1.-pow(u,2.6)),.385));}float u=(y-2.85)/.6;return vec2(0.,1.42-.09*u*u);}return headM(y);}
// The whole mousse: round slices about the bent middle, a little flatter front to back near the top;
// above y 3.95 it bends with the tail value.
float mousseD(vec3 Q){
 vec2 pv=vec2(headM(3.95).x,3.95);float s=smoothstep(3.95,5.13,Q.y);Q.xy=pv+R(-uB.w*.6*s*sqrt(s))*(Q.xy-pv);
 float y=clamp(Q.y,1.41,5.13);vec2 m=prM(y),hi=prM(min(y+.02,5.13)),lo=prM(max(y-.02,1.41));
 float dr=(hi.y-lo.y)/.04,dc=(hi.x-lo.x)/.04,zs=1.-.1*smoothstep(4.2,4.8,y);
 float rho=length(vec2(Q.x-m.x,Q.z/zs)),d=(rho-max(m.y,0.))*zs/sqrt(1.+min(dr*dr,25.)+dc*dc);
 if(Q.y<1.41)d=max(d,length(vec2(rho,Q.y-1.41)));
 if(Q.y>5.13)d=length(Q-vec3(headM(5.13).x,5.13,0.));
 return d;
}
// The glass bowl's profile (radius at height), and its shell: the distance to that curve, turned about the axis.
float gR(float y){if(y<2.85){float u=(2.85-y)/1.49;return 1.52*pow(max(0.,1.-pow(u,2.6)),.385);}float v=sin(clamp((y-2.85)/1.26,0.,1.)*1.5708);return 1.52-.16*v*v;}
float gD(vec3 Q){vec2 q=vec2(length(Q.xz),Q.y);
 float d=min(seg2(q,vec2(0.,1.36),vec2(.55,1.41)),seg2(q,vec2(.55,1.41),vec2(1.,1.57)));
 float y=clamp(q.y,1.57,4.11),dr=(gR(min(y+.02,4.11))-gR(max(y-.02,1.57)))/.04;
 float e=q.y>4.11?length(q-vec2(1.36,4.11)):q.y<1.57?length(q-vec2(1.,1.57)):abs(q.x-gR(y))/sqrt(1.+dr*dr);
 return min(d,e)-.014;}
float stemM(vec3 P){float d=sdE(P-vec3(0.,.04,0.),vec3(.87,.045,.87));
 d=smin(d,sdRC(P,vec3(0.,.1,0.),vec3(0.,.32,0.),.3,.13),.06);d=min(d,sdRC(P,vec3(0.,.32,0.),vec3(0.,1.1,0.),.13,.105));return smin(d,sdRC(P,vec3(0.,1.1,0.),vec3(0.,1.37,0.),.105,.24),.04);}
// The eyes: flat shapes on the front of the glass where the logo's < > are, in any of the shapes and feelings.
float eyesM(vec3 Q){
 float blk=1e5,es=uE2.z,op=uE.x;
 for(int i=0;i<2;i++){float s=i==0?-1.:1.;float a=s*.255+uE2.x*.22,ey=2.2+uE2.y*1.2;vec3 n=vec3(sin(a),0.,cos(a)),tg=vec3(cos(a),0.,-sin(a)),e=n*1.465+vec3(0.,ey,0.);
  vec3 r=Q-e;vec2 f=vec2(dot(r,tg),r.y)/1.35;float w=dot(r,n);
  float d2=eye2(f,op,es,s,uK.y);float top=max(eyeHH(uK.y)*op,.012)*es*(1.-.3*uE.w)-uE.w*.6*(f.x*s);d2=-smin(-d2,-(f.y-top)*.7,.03);
  float py=uE.z>0.?f.y:-f.y;float dc=arc(vec2(f.x,py+.13),1.1,.17)-.045*es;d2=mix(d2,dc,uE.y)*1.35;
  vec2 v=vec2(d2,abs(w)-.012);blk=min(blk,min(max(v.x,v.y),0.)+length(max(v,0.)));}
 return blk;
}
vec2 mapM(vec3 p){
 vec3 P=toP(p),Q=toQ(P);
 float clay=mousseD(Q);
 float gl=stemM(P),rim=length(vec2(length(Q.xz)-1.36,Q.y-4.11))-.024,blk=eyesM(Q);
 // Accessories in the mouse's frames, placed on the Mousse: hats (beret, beanie, cap, crown, chef's hat)
 // tilted on its left shoulder beside the curl, headphones, goggles and hood around its top, glasses on
 // its eyes, the bow tie, scarf and laptop by the stem.
 float hb=uAcc<3.5?1.22:uAcc<6.5?1.:uAcc<7.5?1.37:1.28;vec2 hx=R(.38)*(Q.xy-vec2(-.5,4.12))/.85;vec3 qh=vec3(hx.x,hx.y+hb,(Q.z-.1)/.85);
 vec3 qt=(Q-vec3(0.,3.55,0.))*.78+HC,qf=vec3(Q.x*.95,(Q.y-2.2)*.95+.55,(Q.z-1.5)*.95+.9),bn=(P-vec3(0.,1.15,0.))*1.4+vec3(0.,-.3,0.);
 float a=uAcc,hat=float(a>2.5&&a<3.5||a>4.5&&a<7.5||a>9.5&&a<10.5),ac=hat>.5?accD(qh,bn,1e5)*.85:a>1.5&&a<2.5?accD(qf,bn,1e5)/.95:a>7.5&&a<9.5?accD(qt,bn+vec3(0.,0.,a<8.5?.3:0.),1e5)/1.4:accD(qt,bn,1e5)/.78,lap=1e5,logo=1e5,sw=1e5;
 if(uH2.w>.01){float L=uH2.w;lap=sdB(bn-vec3(0.,-.95,.62),vec3(.36,.018,.22)*L,.012);vec3 s2=bn-vec3(0.,-.95,.84);s2.yz=R(.22)*s2.yz;s2.y-=.25*L;lap=min(lap,sdB(s2,vec3(.36,.25,.016)*L,.035));
  vec2 g=s2.xy/max(L,.01);float l2=length(g)-.055;logo=max(l2*L,abs(s2.z-.053*L)-.006);lap/=1.4;logo/=1.4;}
 if(uE2.w>.01){vec3 s0=qt-vec3(.98,1.02-.06*uE2.w,.4);sw=smin(sdE(s0,vec3(.085,.11,.07)*uE2.w),sdE(s0-vec3(0.,.1*uE2.w,0.),vec3(.03,.06,.03)*uE2.w),.05)/.78;}
 float d=min(min(min(clay,blk),min(gl,rim)),min(min(sw,logo),min(ac,lap)));
 return vec2(d*MS*.8,d==clay?0.:d==blk?1.:d==sw?2.:d==ac?3.:d==lap?4.:d==gl?6.:d==rim?7.:5.);
}
// The logo's mousse gradient (light at the top, deep at the bottom) on the bot's colour, by height in the logo frame.
vec3 mousseCol(float y){vec3 B=uCol,W=vec3(1.),D=uCol*vec3(.3,.26,.38);float t=(3.7-y)/2.81;
 vec3 c=t<.154?mix(mix(B,W,.82),mix(B,W,.6),t/.154):t<.357?mix(mix(B,W,.6),mix(B,W,.2),(t-.154)/.203):t<.466?mix(mix(B,W,.2),B,(t-.357)/.109):t<.553?mix(B,B*.86,(t-.466)/.087):t<.75?mix(B*.86,mix(B,D,.6),(t-.553)/.197):mix(mix(B,D,.6),mix(B,D,.72),clamp((t-.75)/.25,0.,1.));
 vec3 w=mix(mix(B,W,.66),mix(B,W,.5),smoothstep(4.6,5.1,y));return mix(c,w,smoothstep(3.5,3.9,y));}
vec2 map(vec3 p){
 if(uK.x>.5)return mapM(p);
 p.y-=uB.x;
 float sq=uB.y;vec3 b=p;b.y=(b.y+1.47)/sq-1.47;b.xz*=sqrt(sq);
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
 float clay=hood?min(head,dr):smin(smin(head,db,.14),dr,.06);
 float blk=1e5;
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
 float lap=1e5,ac=accD(q,b,hood?db:1e5);
 float logo=1e5;if(uH2.w>.01){float L=uH2.w;lap=sdB(b-vec3(0.,-.95,.62),vec3(.36,.018,.22)*L,.012);vec3 s2=b-vec3(0.,-.95,.84);s2.yz=R(.22)*s2.yz;s2.y-=.25*L;lap=min(lap,sdB(s2,vec3(.36,.25,.016)*L,.035));
  vec2 g=s2.xy/max(L,.01);float l2=length(g)-.055;logo=max(l2*L,abs(s2.z-.053*L)-.006);}
 float sw=1e5;if(uE2.w>.01){vec3 s0=q-vec3(.98,1.02-.06*uE2.w,.4);sw=smin(sdE(s0,vec3(.085,.11,.07)*uE2.w),sdE(s0-vec3(0.,.1*uE2.w,0.),vec3(.03,.06,.03)*uE2.w),.05);}
 float d=min(min(clay,blk),min(min(sw,logo),min(ac,lap)));
 return vec2(d*.8,d==clay?0.:d==blk?1.:d==sw?2.:d==ac?3.:d==lap?4.:5.);
}
vec3 nrm(vec3 p){const vec2 k=vec2(1.,-1.)*.0009;return normalize(k.xyy*map(p+k.xyy).x+k.yyx*map(p+k.yyx).x+k.yxy*map(p+k.yxy).x+k.xxx*map(p+k.xxx).x);}
float ao(vec3 p,vec3 n){float o=0.,s=1.;for(int i=1;i<=5;i++){float h=.02+.07*float(i);o+=(h-map(p+n*h).x/.8)*s;s*=.7;}return clamp(1.-1.6*o,0.,1.);}
vec4 shade(vec2 uv){
 float vx=uV.x;if(uK.x>.5&&vx>.5)vx=.6;vec3 tg=vec3(0.,vx,0.),ro=vec3(0.,vx+.9,9.);vec3 fw=normalize(tg-ro),rt=normalize(cross(fw,vec3(0.,1.,0.))),up=cross(rt,fw);
 float th=uV.y/9.*(uK.x>.5&&uV.x>.5?1.16:1.);vec3 rd=normalize(fw+uv.x*th*rt+uv.y*th*up);
 vec3 oc=ro-vec3(0.,.35,0.);float bb=dot(oc,rd),cc=dot(oc,oc)-8.5,hh=bb*bb-cc;float t=0.;bool hit=false;
 if(hh>0.){hh=sqrt(hh);t=max(-bb-hh,0.);float tm=-bb+hh;for(int i=0;i<110;i++){float d=map(ro+rd*t).x;if(d<.0012*t){hit=true;break;}t+=d;if(t>tm)break;}}
 bool mk=uK.x>.5;vec4 bg=vec4(0.);
 if(!hit&&rd.y<0.){vec3 g=ro+rd*((-1.48-ro.y)/rd.y);bg=vec4(0.,0.,0.,exp(-(g.x*g.x/.45+g.z*g.z/.16))*.42*(1.-clamp(uB.x*1.4,0.,.7)));}
 float ga=0.;vec3 gc=vec3(0.);
 if(mk&&hh>0.){float tg=max(-bb-hh,0.),te=hit?t:-bb+hh;
  for(int i=0;i<64;i++){vec3 q=ro+rd*tg;float d=gD(toQ(toP(q)))*MS;if(d<.0008*tg){vec3 ng=normalize(vec3(gD(toQ(toP(q+vec3(.002,0.,0.))))-gD(toQ(toP(q-vec3(.002,0.,0.)))),gD(toQ(toP(q+vec3(0.,.002,0.))))-gD(toQ(toP(q-vec3(0.,.002,0.)))),gD(toQ(toP(q+vec3(0.,0.,.002))))-gD(toQ(toP(q-vec3(0.,0.,.002))))));
    ga=.07+.93*smoothstep(.72,.86,1.-abs(dot(ng,rd)));gc=pow(uCol*.76,vec3(2.2));break;}tg+=d*.9;if(tg>te)break;}}
 if(!hit){if(ga>0.)return vec4(pow(gc,vec3(1./2.2))*ga,ga+bg.a*(1.-ga));return bg;}
 vec3 p=ro+rd*t;float m=map(p).y;vec3 n=nrm(p);float o=ao(p,n);
 vec3 L=normalize(vec3(-.55,.75,.65)),F=normalize(vec3(.75,.15,.5));
 float nl=dot(n,L),dif=clamp(nl,0.,1.),wr=pow(nl*.5+.5,1.7),fil=clamp(dot(n,F),0.,1.),fr=pow(1.-clamp(dot(n,-rd),0.,1.),3.);
 float spc=pow(clamp(dot(n,normalize(L-rd)),0.,1.),m>.5?36.:12.);
 vec3 col;
 float band=mix(.8,1.,smoothstep(-.06,.06,dot(n,L)+.12));
 if(mk&&m<.5){col=pow(mousseCol(toP(p).y),vec3(2.2))*band;}
 else if(mk&&m<1.5){col=uK.z>.5?vec3(1.):vec3(.004);}
 else if(mk&&m>5.5){col=pow(m<6.5?uCol*.76:mix(uCol,vec3(1.),.35),vec3(2.2))*band;}
 else if(m<.5){vec3 a=pow(uCol,vec3(2.2));col=a*(.16+1.0*wr)*mix(.5,1.,o)+a*fil*.14+.05*spc*dif+a*fr*.3+a*a*.15*(1.-dif)*o;col+=vec3(.55,.7,1.)*a*uH2.w*.45*clamp(dot(n,normalize(vec3(0.,-.5,1.))),0.,1.)*smoothstep(-.4,.2,p.y-uB.x);}
 else if(m<1.5){col=vec3(.02)*(.5+wr)*mix(.6,1.,o)+.3*spc*dif*o+vec3(.07)*fr*o;}
 else if(m<2.5){vec3 a=vec3(.5,.78,1.);col=a*(.3+.7*wr)+.5*spc;}
 else if(m<3.5){vec3 a=pow(uAC.rgb,vec3(2.2));float sp2=pow(clamp(dot(n,normalize(L-rd)),0.,1.),uAC.w>.5?50.:20.);
  col=a*(.14+.9*wr)*mix(.55,1.,o)+a*fil*.12+(uAC.w>.5?a*1.4*sp2+a*fr*.5:vec3(.12)*sp2*dif)+vec3(.05)*fr*o;}
 else if(m<4.5){vec3 a=vec3(.05,.052,.06);col=a*(.3+.9*wr)*mix(.6,1.,o)+.28*pow(clamp(dot(n,normalize(L-rd)),0.,1.),40.)+vec3(.12)*fr;}
 else{col=vec3(.8,.9,1.);}
 if(ga>0.&&!(mk&&m>.5&&m<1.5))col=mix(col,gc,ga);
 return vec4(pow(col,vec3(1./2.2)),1.);
}
void main(){vec2 fc=gl_FragCoord.xy-uOrg;vec4 c=vec4(0.);float n=uV.z;
 for(int j=0;j<2;j++)for(int i=0;i<2;i++){if(float(i)>=n||float(j)>=n)continue;vec2 o=(vec2(float(i),float(j))+.5)/n-.5;c+=shade(((fc+o)/uRes)*2.-1.);}
 gl_FragColor=c/(n*n);}
`
