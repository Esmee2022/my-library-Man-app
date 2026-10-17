import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

const BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/$/, '');
type Profile = { role: string; display_name: string; email: string };
type Book = { id: string; title: string; author: string; isbn?: string; category?: string; availableCopies: number; totalCopies: number; availablePhysicalCopies?: number; physicalCopies?: number; availableEbookLicenses?: number; ebookLicenses?: number; formats?: string[] };
type Loan = { id: string; borrowed_at: string; due_at: string; returned_at?: string; copy?: { barcode: string; format?: string; digital_url?: string; book?: { title: string } }; borrower?: { display_name: string } };
type Auth = { token: string; csrf: string; user: { email: string; name?: string; role: string } };
const C = { blue: '#087cff', dark: '#303943', muted: '#7c858e', bg: '#e7ebf0', red: '#b42318' };

async function readAuth(): Promise<Auth | null> { try { const s = await SecureStore.getItemAsync('library-auth'); return s ? JSON.parse(s) : null; } catch { return null; } }
async function request(path: string, auth: Auth | null, init: RequestInit = {}) {
  if (!BASE) throw new Error('Set EXPO_PUBLIC_API_URL to your deployed HTTPS API (or local emulator URL for development).');
  if (!/^https:\/\//i.test(BASE) && !__DEV__) throw new Error('The mobile app requires HTTPS outside development.');
  const headers: Record<string,string> = { ...(init.headers as Record<string,string> || {}) };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth?.csrf && ['POST','PATCH','DELETE'].includes((init.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = auth.csrf;
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export default function Home() {
  const [auth,setAuth] = useState<Auth|null>(null); const [profile,setProfile] = useState<Profile|null>(null);
  const [step,setStep] = useState<any>(null); const [email,setEmail] = useState(''); const [password,setPassword] = useState(''); const [code,setCode] = useState('');
  const [query,setQuery] = useState(''); const [books,setBooks] = useState<Book[]>([]); const [loans,setLoans] = useState<Loan[]>([]); const [users,setUsers] = useState<any[]>([]);
  const [tab,setTab] = useState<'catalog'|'loans'|'operations'|'reports'>('catalog'); const [summary,setSummary] = useState<any>(null); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [info,setInfo] = useState('');

  async function loadSession(a: Auth) { setAuth(a); const p = await request('/library/me',a); setProfile(p.user); await loadData(a,p.user.role); }
  async function loadData(a = auth, role = profile?.role) {
    if (!a) return;
    const c = await request(`/library/catalog${query.trim()?`?q=${encodeURIComponent(query.trim())}`:''}`,a); setBooks(c.books||[]);
    const l = await request(role === 'student' ? '/library/loans' : '/library/loans?status=open',a); setLoans(l.loans||[]);
    if (role === 'manager' || role === 'administrator') setSummary(await request('/library/reports/summary',a));
    if (role === 'librarian' || role === 'administrator') { const u=await request('/library/users',a); setUsers((u.users||[]).filter((x:any)=>x.role==='student'&&x.active&&x.library_access)); }
  }
  useEffect(()=>{ (async()=>{ try { const saved=await readAuth(); if(saved) await loadSession(saved); } catch(e:any) { await SecureStore.deleteItemAsync('library-auth'); setError(e.message); } })(); },[]);

  async function login() { setBusy(true); setError(''); try { const data=await request('/auth/login',null,{method:'POST',body:JSON.stringify({email,password})}); setStep(data); setCode(''); } catch(e:any) { setError(e.message); } finally { setBusy(false); } }
  async function verify() { if(!step?.tempToken) return; setBusy(true); setError(''); try {
    const numeric=/^\d{6}$/.test(code.trim()); const data=await request('/auth/2fa',null,{method:'POST',body:JSON.stringify({tempToken:step.tempToken,totpCode:numeric?code.trim():null,recoveryCode:numeric?null:code.trim(),mobile:true})});
    if(!data.sessionToken) throw new Error('The server did not return a mobile session token. Update the backend first.');
    const a={token:data.sessionToken,csrf:data.csrfToken,user:data.user}; await SecureStore.setItemAsync('library-auth',JSON.stringify(a)); await loadSession(a);
    setStep(null); setPassword(''); setCode('');
  } catch(e:any) { setError(e.message); } finally { setBusy(false); } }
  async function logout() { try { if(auth) await request('/auth/logout',auth,{method:'POST',body:'{}'}); } catch {} await SecureStore.deleteItemAsync('library-auth'); setAuth(null);setProfile(null);setBooks([]);setLoans([]);setStep(null); }
  async function recordReturn(id:string) { if(!auth) return; setBusy(true);setError('');try{await request(`/library/loans/${id}/return`,auth,{method:'POST',body:'{}'});setInfo('Return recorded.');await loadData();}catch(e:any){setError(e.message);}finally{setBusy(false);} }
  async function search() { try { await loadData(); } catch(e:any){setError(e.message);} }

  if (!auth || !profile) return <ScrollView style={s.scroll} contentContainerStyle={s.page} horizontal={false} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"><View style={s.card}><Text style={s.brand}>Library Workspace</Text><Text style={s.muted}>Secure access with two-factor authentication</Text>
    {!!error&&<Text style={s.error}>{error}</Text>}
    {!step ? <><TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="Email address"/><TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="Password"/><Button label={busy?'Checking…':'Continue'} onPress={login} disabled={busy||!email||!password}/></> : <>
      {!step.enrolled&&<View style={s.enroll}>{step.qrCode&&<Image source={{uri:step.qrCode}} style={s.qr}/>}<Text style={s.muted}>Scan in an authenticator app or enter this setup key:</Text><Text selectable style={s.codeText}>{step.manualSecret}</Text>{(step.recoveryCodes||[]).map((v:string)=><Text key={v} selectable style={s.codeText}>{v}</Text>)}</View>}
      <TextInput style={s.input} value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="6-digit code or recovery code"/><Button label={busy?'Verifying…':'Verify and sign in'} onPress={verify} disabled={busy||!code}/><Pressable onPress={()=>setStep(null)}><Text style={s.link}>Back to login</Text></Pressable>
    </>}
  </View></ScrollView>;

  const tabs: Array<typeof tab> = ['catalog','loans',...(profile.role==='librarian'||profile.role==='administrator'?['operations' as const]:[]),...(profile.role==='manager'||profile.role==='administrator'?['reports' as const]:[])];
  return <ScrollView style={s.scroll} contentContainerStyle={s.page} horizontal={false} showsHorizontalScrollIndicator={false}>
    <View style={s.card}>
    <View style={s.header}><View style={s.profile}><Text style={s.brand}>Library</Text><Text style={s.muted}>{profile.display_name} · {profile.role}</Text></View></View>
    {!!error&&<Text style={s.error}>{error}</Text>}{!!info&&<Text style={s.success}>{info}</Text>}
    <View style={s.tabs}>{tabs.map(t=><Pressable key={t} style={[s.tab,tab===t&&s.selected]} onPress={()=>{setTab(t);setError('');}}><Text style={[s.tabText,tab===t&&s.selectedText]}>{t==='catalog'?'Catalogue':t==='loans'?'My loans':t==='operations'?'Circulation':'Reports'}</Text></Pressable>)}</View>
    {tab==='catalog'&&<><TextInput style={s.input} value={query} onChangeText={setQuery} placeholder="Search title, author, ISBN or category" onSubmitEditing={search}/><Button label="Search" onPress={search}/>{books.map(b=><View key={b.id} style={s.item}><Text style={s.itemTitle}>{b.title}</Text><Text style={s.muted}>{b.author}{b.category?` · ${b.category}`:''}</Text><Text style={s.available}>{(b.formats||['physical']).map(f=>f==='ebook'?'eBook':'Physical').join(' + ')}</Text><Text style={s.muted}>Physical: {b.availablePhysicalCopies??b.availableCopies} available of {b.physicalCopies??b.totalCopies} · eBook licenses: {b.availableEbookLicenses||0} available of {b.ebookLicenses||0}</Text></View>)}</>}
    {tab==='loans'&&loans.map(l=><View key={l.id} style={s.item}><Text style={s.itemTitle}>{l.copy?.book?.title||'Book'} · {l.copy?.format==='ebook'?'eBook':'Physical'}</Text>{profile.role!=='student'&&<Text style={s.muted}>{l.borrower?.display_name}</Text>}<Text style={s.muted}>Borrowed {new Date(l.borrowed_at).toLocaleDateString()} · Due {new Date(l.due_at).toLocaleDateString()}</Text><Text style={Date.parse(l.due_at)<Date.now()&&!l.returned_at?s.overdue:s.available}>{l.returned_at?'Returned':Date.parse(l.due_at)<Date.now()?'Overdue':'On loan'}</Text>{l.copy?.format==='ebook'&&!l.returned_at&&!!l.copy.digital_url&&<Pressable onPress={()=>Linking.openURL(l.copy!.digital_url!)}><Text style={s.link}>Open eBook</Text></Pressable>}{profile.role==='librarian'&&<Button label="Record return" onPress={()=>recordReturn(l.id)} disabled={busy}/>}</View>)}
    {tab==='operations'&&<><Text style={s.section}>Open loans</Text>{loans.map(l=><View key={l.id} style={s.item}><Text style={s.itemTitle}>{l.copy?.book?.title||'Book'}</Text><Text style={s.muted}>{l.borrower?.display_name} · due {new Date(l.due_at).toLocaleDateString()}</Text><Button label="Record return" onPress={()=>recordReturn(l.id)} disabled={busy}/></View>)}<Text style={s.section}>Students eligible to borrow</Text>{users.map(u=><Text key={u.id} style={s.muted}>{u.display_name} · {u.email}</Text>)}<Text style={s.muted}>Book issuing is available at the full Circulation desk in the web workspace.</Text></>}
    {tab==='reports'&&summary&&Object.entries({'Titles':summary.totalTitles,'Physical copies':summary.copies,'eBook licenses':summary.ebookLicenses,'Active loans':summary.activeLoans,'Returned':summary.returnedLoans,'Overdue':summary.overdueLoans}).map(([k,v])=><View key={k} style={s.item}><Text style={s.itemTitle}>{String(v)}</Text><Text style={s.muted}>{k}</Text></View>)}
    <Button label="Refresh" onPress={()=>loadData()} disabled={busy}/>
    <Pressable style={s.logoutButton} onPress={logout} accessibilityRole="button"><Text style={s.logoutText}>Log out</Text></Pressable>
  </View></ScrollView>;
}

function Button({label,onPress,disabled=false}:{label:string;onPress:()=>void;disabled?:boolean}) { return <Pressable style={[s.button,disabled&&{opacity:.5}]} disabled={disabled} onPress={onPress}>{disabled?<ActivityIndicator color="#fff"/>:<Text style={s.buttonText}>{label}</Text>}</Pressable>; }
const s=StyleSheet.create({scroll:{width:'100%',flex:1,alignSelf:'stretch'},page:{width:'100%',flexGrow:1,alignItems:'center',paddingHorizontal:16,paddingVertical:24,backgroundColor:C.bg},card:{width:'100%',maxWidth:700,alignSelf:'center',padding:20,borderRadius:24,backgroundColor:C.bg,elevation:4},brand:{fontSize:26,fontWeight:'800',color:C.dark,marginBottom:4,flexShrink:1},muted:{fontSize:13,color:C.muted,marginBottom:12,flexShrink:1},input:{width:'100%',backgroundColor:C.bg,borderRadius:13,padding:14,marginVertical:8,color:C.dark,elevation:2},button:{backgroundColor:C.blue,padding:14,borderRadius:13,alignItems:'center',marginVertical:8,minHeight:48,justifyContent:'center',width:'100%'},buttonText:{color:'#fff',fontWeight:'700'},error:{color:C.red,marginVertical:10,flexShrink:1},success:{color:'#16713a',marginVertical:10,flexShrink:1},link:{color:C.blue,fontWeight:'700',padding:12},enroll:{alignItems:'center',padding:14,backgroundColor:'#f4f7fa',borderRadius:16,marginVertical:12,width:'100%'},qr:{width:170,height:170,margin:10},codeText:{fontFamily:'monospace',color:C.dark,marginVertical:3,flexShrink:1},header:{flexDirection:'row',alignItems:'center',marginBottom:12},profile:{flex:1,minWidth:0},logoutButton:{alignSelf:'stretch',alignItems:'center',justifyContent:'center',minHeight:48,padding:12,marginTop:12,borderRadius:13,borderWidth:1,borderColor:'#d6a4a4',backgroundColor:'#fff5f5'},logoutText:{color:C.red,fontWeight:'700',fontSize:15},tabs:{flexDirection:'row',flexWrap:'wrap',gap:8,marginBottom:15,width:'100%'},tab:{paddingVertical:10,paddingHorizontal:13,borderRadius:12,backgroundColor:C.bg,elevation:2},selected:{backgroundColor:C.blue},tabText:{color:C.dark,fontWeight:'600'},selectedText:{color:'#fff'},item:{padding:15,borderRadius:15,backgroundColor:'#f0f3f7',marginVertical:7,width:'100%'},itemTitle:{color:C.dark,fontWeight:'700',fontSize:16,marginBottom:3,flexShrink:1},available:{color:'#16713a',fontWeight:'700',fontSize:13,marginTop:5,flexShrink:1},overdue:{color:C.red,fontWeight:'700',fontSize:13,marginTop:5,flexShrink:1},section:{fontSize:18,fontWeight:'700',color:C.dark,marginTop:18,flexShrink:1}});

