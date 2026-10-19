import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

const BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/$/, '');
type Profile = { role: string; display_name: string; email: string };
type Book = { id: string; title: string; author: string; isbn?: string; category?: string; availableCopies: number; totalCopies: number; availablePhysicalCopies?: number; physicalCopies?: number; availableEbookLicenses?: number; ebookLicenses?: number; formats?: string[] };
type Loan = { id: string; borrowed_at: string; due_at: string; returned_at?: string; copy?: { barcode: string; format?: string; digital_url?: string; book?: { title: string } }; borrower?: { display_name: string } };
type Auth = { token: string; csrf: string; user: { email: string; name?: string; role: string } };
const C = { blue: '#087cff', dark: '#303943', muted: '#7c858e', bg: '#eaf0f5', card: 'rgba(231,235,240,0.96)', paper: '#f7f9fc', red: '#b42318', green: '#23734b', navy: '#19365d', line: '#d7e0e8' };
const COVER_COLORS = [['#173f5f','#20639b','#3caea3'],['#402b50','#76528b','#c06c84'],['#30475e','#52616b','#84a9ac'],['#4b3832','#8d6e63','#d7b49e'],['#183a37','#2d6a4f','#95d5b2'],['#422a1f','#a44a3f','#e9c46a']];

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
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [auth,setAuth] = useState<Auth|null>(null); const [profile,setProfile] = useState<Profile|null>(null);
  const [step,setStep] = useState<any>(null); const [email,setEmail] = useState(''); const [password,setPassword] = useState(''); const [code,setCode] = useState('');
  const [query,setQuery] = useState(''); const [books,setBooks] = useState<Book[]>([]); const [loans,setLoans] = useState<Loan[]>([]); const [users,setUsers] = useState<any[]>([]);
  const [adminUsers,setAdminUsers] = useState<any[]>([]); const [auditLogs,setAuditLogs] = useState<any[]>([]); const [security,setSecurity] = useState<any>(null);
  const [roleMenuUser,setRoleMenuUser] = useState<number|null>(null);
  const [updating,setUpdating] = useState(false);
  const [newName,setNewName] = useState(''); const [newEmail,setNewEmail] = useState(''); const [newPassword,setNewPassword] = useState(''); const [newRole,setNewRole] = useState<'student'|'librarian'|'manager'|'administrator'>('student');
  const [tab,setTab] = useState<'catalog'|'loans'|'operations'|'reports'|'admin'>('catalog'); const [summary,setSummary] = useState<any>(null); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [info,setInfo] = useState('');
  const columns = width >= 720 ? 3 : width >= 520 ? 2 : 2;

  async function loadSession(a: Auth) { setAuth(a); const p = await request('/library/me',a); setProfile(p.user); await loadData(a,p.user.role); }
  async function loadData(a = auth, role = profile?.role) {
    if (!a) return;
    const c = await request(`/library/catalog${query.trim()?`?q=${encodeURIComponent(query.trim())}`:''}`,a); setBooks(c.books||[]);
    const l = await request(role === 'student' ? '/library/loans' : '/library/loans?status=open',a); setLoans(l.loans||[]);
    if (role === 'manager' || role === 'administrator') setSummary(await request('/library/reports/summary',a));
    if (role === 'librarian' || role === 'administrator') { const u=await request('/library/users',a); setUsers((u.users||[]).filter((x:any)=>x.role==='student'&&x.active&&x.library_access)); }
    if (role === 'administrator') {
      const [u, logs] = await Promise.all([request('/library/users',a), request('/audit-log?limit=50',a)]);
      setAdminUsers(u.users||[]); setAuditLogs(logs.logs||[]);
    }
  }
  useEffect(()=>{ (async()=>{ try { const saved=await readAuth(); if(saved) await loadSession(saved); } catch(e:any) { await SecureStore.deleteItemAsync('library-auth'); setError(e.message); } })(); },[]);
  const refreshOnFocus=useRef<()=>void>(()=>{});
  refreshOnFocus.current=()=>{if(auth&&profile) void loadData(auth,profile.role);};
  useFocusEffect(useCallback(()=>{refreshOnFocus.current();},[]));

  async function login() { setBusy(true); setError(''); try { const data=await request('/auth/login',null,{method:'POST',body:JSON.stringify({email,password})}); setStep(data); setCode(''); } catch(e:any) { setError(e.message); } finally { setBusy(false); } }
  async function verify() { if(!step?.tempToken) return; setBusy(true); setError(''); try {
    const numeric=/^\d{6}$/.test(code.trim()); const data=await request('/auth/2fa',null,{method:'POST',body:JSON.stringify({tempToken:step.tempToken,totpCode:numeric?code.trim():null,recoveryCode:numeric?null:code.trim(),mobile:true})});
    if(!data.sessionToken) throw new Error('The server did not return a mobile session token. Update the backend first.');
    const a={token:data.sessionToken,csrf:data.csrfToken,user:data.user}; await SecureStore.setItemAsync('library-auth',JSON.stringify(a)); await loadSession(a);
    setStep(null); setPassword(''); setCode('');
  } catch(e:any) { setError(e.message); } finally { setBusy(false); } }
  async function logout() { try { if(auth) await request('/auth/logout',auth,{method:'POST',body:'{}'}); } catch {} await SecureStore.deleteItemAsync('library-auth'); setAuth(null);setProfile(null);setBooks([]);setLoans([]);setStep(null); }
  async function recordReturn(id:string) { if(!auth) return; setBusy(true);setError('');try{await request(`/library/loans/${id}/return`,auth,{method:'POST',body:'{}'});setInfo('Return recorded.');await loadData();}catch(e:any){setError(e.message);}finally{setBusy(false);} }
  async function search() { setBusy(true); setError(''); try { await loadData(); } catch(e:any){setError(e.message);} finally { setBusy(false); } }
  async function checkForUpdates() {
    if(updating) return;
    setUpdating(true);setError('');setInfo('');
    try {
      if(__DEV__||!Updates.isEnabled) { setInfo('In-app updates work after you install the new EAS preview APK.'); return; }
      const update=await Updates.checkForUpdateAsync();
      if(!update.isAvailable) { setInfo('Your app is already up to date.'); return; }
      setInfo('Downloading the update…');
      const downloaded=await Updates.fetchUpdateAsync();
      if(downloaded.isNew) { setInfo('Update ready. Restarting the app…'); await Updates.reloadAsync(); }
      else setInfo('No new update was downloaded.');
    } catch(e:any) { setError(e.message||'Could not check for updates. Please try again.'); }
    finally { setUpdating(false); }
  }
  async function createAccount() {
    if(!auth) return; setBusy(true);setError('');setInfo('');
    try { const result=await request('/users',auth,{method:'POST',body:JSON.stringify({name:newName.trim(),email:newEmail.trim(),password:newPassword,libraryRole:newRole})});
      setInfo(result.message||'Account created.');setNewName('');setNewEmail('');setNewPassword('');setNewRole('student');await loadData();
    } catch(e:any) { setError(e.message); } finally { setBusy(false); }
  }
  async function deleteAccount(id:number,email:string) {
    if(!auth) return;
    Alert.alert('Delete account',`Remove the sign-in account for ${email}? The library profile and audit record will be retained.`,[
      {text:'Cancel',style:'cancel'},
      {text:'Delete account',style:'destructive',onPress:async()=>{setBusy(true);setError('');try{await request(`/users/${id}`,auth,{method:'DELETE'});setSecurity(null);setInfo('Account deleted. Its library history and audit event are retained.');await loadData();}catch(e:any){setError(e.message);}finally{setBusy(false);}}}
    ]);
  }
  async function setAccountRole(user:any,role:'student'|'librarian'|'manager'|'administrator') {
    if(!auth||role===user.role) { setRoleMenuUser(null); return; }
    setBusy(true);setError('');
    try{await request(`/users/${user.local_user_id}/role`,auth,{method:'PATCH',body:JSON.stringify({role})});setInfo(`Role changed to ${role}.`);setRoleMenuUser(null);await loadData();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function toggleAccount(user:any) {
    if(!auth) return; const active=!user.active;setBusy(true);setError('');
    try{await request(`/library/users/${user.local_user_id}/access`,auth,{method:'PATCH',body:JSON.stringify({active})});setInfo(active?'Account activated.':'Account deactivated.');await loadData();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  function revealSecurity(user:any) {
    if(!auth) return;
    Alert.alert('Reveal account hash and salt?',`This displays the one-way password hash and this account’s individual salt for ${user.email}. The password cannot be recovered. The server pepper is deliberately never sent to this app.`,[
      {text:'Cancel',style:'cancel'},
      {text:'Reveal details',onPress:async()=>{setBusy(true);setError('');try{const result=await request(`/users/${user.local_user_id}/security?reveal=1`,auth);setSecurity(result.security);}catch(e:any){setError(e.message);}finally{setBusy(false);}}}
    ]);
  }

  if (!auth || !profile) return <ScrollView style={s.scroll} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
    <View style={[s.loginCard,{maxWidth:480}]}>
      <BrandMark large />
      <Text style={s.loginEyebrow}>LIBRARY WORKSPACE</Text>
      <Text style={s.loginTitle}>Welcome back</Text>
      <Text style={s.loginIntro}>Sign in securely to your library account.</Text>
      {!!error&&<Text style={s.error}>{error}</Text>}
      {!step ? <>
        <Text style={s.label}>Email address</Text><TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="you@example.com" placeholderTextColor="#8a96a3" />
        <Text style={s.label}>Password</Text><TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" placeholder="Enter your password" placeholderTextColor="#8a96a3" />
        <Button label={busy?'Signing in…':'Continue'} onPress={login} disabled={busy||!email||!password}/>
      </> : <>
        {!step.enrolled&&<View style={s.enroll}>{step.qrCode&&<Image source={{uri:step.qrCode}} style={s.qr}/>}<Text style={s.bodyText}>Scan with an authenticator app or enter the setup key:</Text><Text selectable style={s.codeText}>{step.manualSecret}</Text>{(step.recoveryCodes||[]).map((v:string)=><Text key={v} selectable style={s.codeText}>{v}</Text>)}</View>}
        <Text style={s.label}>Verification code</Text><TextInput style={s.input} value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} keyboardType="number-pad" placeholder="6-digit or recovery code" placeholderTextColor="#8a96a3" />
        <Button label={busy?'Verifying…':'Verify and sign in'} onPress={verify} disabled={busy||!code}/><Pressable onPress={()=>setStep(null)}><Text style={s.link}>Back to login</Text></Pressable>
      </>}
      <Text style={s.loginFoot}>Protected with two-factor authentication</Text>
    </View>
  </ScrollView>;

  const isStaff=profile.role==='librarian'||profile.role==='administrator';
  const tabs: Array<typeof tab> = ['catalog','loans',...(isStaff?['operations' as const]:[]),...(profile.role==='manager'||profile.role==='administrator'?['reports' as const]:[]),...(profile.role==='administrator'?['admin' as const]:[])];
  const labels: Record<typeof tab,string>={catalog:'Catalogue',loans:'My loans',operations:'Circulation',reports:'Reports',admin:'Administration'};
  return <ScrollView style={[s.scroll,{backgroundColor:'#f2f3f8'}]} contentContainerStyle={s.appPage} showsVerticalScrollIndicator={false}>
    <View style={s.shell}>
      <View style={s.headerCard}>
        <View style={s.brandRow}><BrandMark /><View style={s.brandCopy}><WorkspaceText style={s.headerTitle}>Library Workspace</WorkspaceText><WorkspaceText style={s.headerWelcome}>Welcome, {profile.display_name}</WorkspaceText></View></View>
        <View style={s.roleBadge}><WorkspaceText style={s.roleBadgeText}>{profile.role}</WorkspaceText></View>
      </View>
      <View style={s.nav}>
        {tabs.map(t=><Pressable key={t} style={[s.navItem,{width:tabs.length>=3?'31.5%':'48.5%'},tab===t&&s.navItemActive]} onPress={()=>{setTab(t);setError('');setInfo('');setSecurity(null);}}><WorkspaceText style={[s.navText,tab===t&&s.navTextActive]}>{labels[t]}</WorkspaceText></Pressable>)}
      </View>
      {!!error&&<WorkspaceText style={s.error}>{error}</WorkspaceText>}{!!info&&<WorkspaceText style={s.success}>{info}</WorkspaceText>}

      {tab==='catalog'&&<View style={s.sectionCard}>
        <SectionHeading title="Catalogue" subtitle="Browse the physical collection and available eBook licenses." />
        <View style={s.searchRow}><TextInput style={[s.input,s.searchInput,s.workspaceInput]} value={query} onChangeText={setQuery} placeholder="Title, author, ISBN or category" placeholderTextColor="#8a96a3" returnKeyType="search" onSubmitEditing={search}/><Pressable style={s.searchButton} onPress={search} accessibilityRole="button"><WorkspaceText style={s.searchButtonText}>Search</WorkspaceText></Pressable></View>
        <WorkspaceText style={s.countText}>{books.length} {books.length===1?'title':'titles'}</WorkspaceText>
        <View style={s.bookGrid}>{books.map((b,i)=><BookCard key={b.id} book={b} index={i} columns={columns} onPress={()=>router.push({pathname:'/book/[id]',params:{id:b.id}})}/>)}</View>
        {!books.length&&<View style={s.empty}><WorkspaceText style={s.emptyTitle}>No titles to show</WorkspaceText><WorkspaceText style={s.bodyText}>Try a different search or refresh the catalogue.</WorkspaceText></View>}
      </View>}

      {tab==='loans'&&<View style={s.sectionCard}><SectionHeading title="Loan history" subtitle="Your current and returned books."/>
        {!loans.length&&<EmptyState message="No loans to show yet."/>}
        {loans.map(l=><View key={l.id} style={s.loanCard}><View style={s.loanHead}><WorkspaceText style={s.loanTitle}>{l.copy?.book?.title||'Book'}</WorkspaceText><StatusBadge label={l.returned_at?'Returned':Date.parse(l.due_at)<Date.now()?'Overdue':'On loan'} danger={!l.returned_at&&Date.parse(l.due_at)<Date.now()}/></View>
          <WorkspaceText style={s.bodyText}>{l.copy?.format==='ebook'?'eBook license':'Physical copy'}{profile.role!=='student'&&l.borrower?.display_name?` · ${l.borrower.display_name}`:''}</WorkspaceText>
          <WorkspaceText style={s.metaText}>Borrowed {new Date(l.borrowed_at).toLocaleDateString()} · Due {new Date(l.due_at).toLocaleDateString()}</WorkspaceText>
          {l.copy?.format==='ebook'&&!l.returned_at&&!!l.copy.digital_url&&<Pressable style={s.inlineLink} onPress={()=>Linking.openURL(l.copy!.digital_url!)}><WorkspaceText style={s.inlineLinkText}>Open eBook</WorkspaceText></Pressable>}
          {profile.role==='librarian'&&!l.returned_at&&<Button label="Record return" onPress={()=>recordReturn(l.id)} disabled={busy} workspace/>}
        </View>)}
      </View>}

      {tab==='operations'&&<View style={s.sectionCard}><SectionHeading title="Circulation desk" subtitle="Monitor open loans and eligible readers."/>
        <WorkspaceText style={s.sectionTitle}>Open loans</WorkspaceText>{!loans.length&&<EmptyState message="There are no open loans right now."/>}
        {loans.map(l=><View key={l.id} style={s.loanCard}><WorkspaceText style={s.loanTitle}>{l.copy?.book?.title||'Book'}</WorkspaceText><WorkspaceText style={s.bodyText}>{l.borrower?.display_name||'Reader'} · due {new Date(l.due_at).toLocaleDateString()}</WorkspaceText><Button label="Record return" onPress={()=>recordReturn(l.id)} disabled={busy} workspace/></View>)}
        <WorkspaceText style={s.sectionTitle}>Students eligible to borrow</WorkspaceText>{!users.length&&<WorkspaceText style={s.bodyText}>No eligible students found.</WorkspaceText>}{users.map(u=><View key={u.id} style={s.userRow}><View style={s.userAvatar}><WorkspaceText style={s.userInitial}>{String(u.display_name||'R').charAt(0).toUpperCase()}</WorkspaceText></View><View style={s.userInfo}><WorkspaceText style={s.userName}>{u.display_name}</WorkspaceText><WorkspaceText style={s.metaText}>{u.email}</WorkspaceText></View></View>)}
      </View>}

      {tab==='reports'&&<View style={s.sectionCard}><SectionHeading title="Library overview" subtitle="A quick summary of the collection and circulation."/>
        <View style={s.metricsGrid}>{Object.entries({'Titles':summary?.totalTitles,'Physical copies':summary?.copies,'eBook licenses':summary?.ebookLicenses,'Active loans':summary?.activeLoans,'Returned':summary?.returnedLoans,'Overdue':summary?.overdueLoans}).map(([k,v],i)=><View key={k} style={[s.metricCard,{width:columns===3?'31.5%':'48.5%'}]}><WorkspaceText style={[s.metricValue,i===5&&Number(v)>0?s.metricDanger:null]}>{v==null?'—':String(v)}</WorkspaceText><WorkspaceText style={s.metricLabel}>{k}</WorkspaceText></View>)}</View>
      </View>}

      {tab==='admin'&&<>
        <View style={s.sectionCard}>
          <SectionHeading title="Administration" subtitle="Manage library accounts and review security activity."/>
          <View style={s.adminInfo}><WorkspaceText style={s.adminInfoTitle}>Signed in as</WorkspaceText><WorkspaceText style={s.bodyText}>{profile.display_name} · {profile.email}</WorkspaceText><StatusBadge label="Administrator"/></View>
        </View>
        <View style={s.sectionCard}>
          <SectionHeading title="Add account" subtitle="Create a student, librarian, manager, or administrator account."/>
          <WorkspaceText style={s.label}>Full name</WorkspaceText><TextInput style={[s.input,s.workspaceInput]} value={newName} onChangeText={setNewName} placeholder="Full name" placeholderTextColor="#8a96a3" autoComplete="name"/>
          <WorkspaceText style={s.label}>Email address</WorkspaceText><TextInput style={[s.input,s.workspaceInput]} value={newEmail} onChangeText={setNewEmail} placeholder="name@example.com" placeholderTextColor="#8a96a3" autoCapitalize="none" keyboardType="email-address" autoComplete="email"/>
          <WorkspaceText style={s.label}>Temporary password</WorkspaceText><TextInput style={[s.input,s.workspaceInput]} value={newPassword} onChangeText={setNewPassword} placeholder="Choose a strong temporary password" placeholderTextColor="#8a96a3" secureTextEntry autoComplete="new-password"/>
          <WorkspaceText style={s.label}>Account role</WorkspaceText><View style={s.roleOptions}>{(['student','librarian','manager','administrator'] as const).map(role=><Pressable key={role} style={[s.roleOption,newRole===role&&s.roleOptionSelected]} onPress={()=>setNewRole(role)}><WorkspaceText style={[s.roleOptionText,newRole===role&&s.roleOptionTextSelected]}>{role}</WorkspaceText></Pressable>)}</View>
          <Button label={busy?'Saving…':'Create account'} onPress={createAccount} disabled={busy||!newName.trim()||!newEmail.trim()||!newPassword} workspace/>
        </View>
        <View style={s.sectionCard}>
          <View style={s.adminListHead}><View style={{flex:1}}><SectionHeading title="Users and access" subtitle={`${adminUsers.length} account${adminUsers.length===1?'':'s'} · removed sign-ins remain listed as deleted`}/></View><Pressable style={s.refresh} onPress={search}><WorkspaceText style={s.refreshText}>Refresh</WorkspaceText></Pressable></View>
          {!adminUsers.length&&<EmptyState message="No accounts found."/>}
          {adminUsers.map((u:any)=><View key={u.local_user_id} style={s.adminUserCard}>
            <View style={s.adminUserTop}><View style={s.userAvatar}><WorkspaceText style={s.userInitial}>{String(u.display_name||u.email||'U').charAt(0).toUpperCase()}</WorkspaceText></View><View style={s.userInfo}><WorkspaceText style={s.userName}>{u.display_name||'Library user'}</WorkspaceText><WorkspaceText style={s.metaText}>{u.email}</WorkspaceText><View style={s.userBadges}><StatusBadge label={u.authentication_exists===false?'Deleted':u.active?'Active':'Inactive'} danger={u.authentication_exists!==false&&!u.active}/><WorkspaceText style={s.roleText}>{u.role}</WorkspaceText></View></View></View>
            {u.authentication_exists!==false&&u.email?.toLowerCase()!==profile.email.toLowerCase()&&<View style={s.actionGrid}>
              <Pressable style={s.secondaryAction} onPress={()=>revealSecurity(u)}><WorkspaceText style={s.secondaryActionText}>View hash & salt</WorkspaceText></Pressable>
              <Pressable style={s.secondaryAction} onPress={()=>setRoleMenuUser(roleMenuUser===Number(u.local_user_id)?null:Number(u.local_user_id))}><WorkspaceText style={s.secondaryActionText}>Change role</WorkspaceText></Pressable>
              <Pressable style={s.secondaryAction} onPress={()=>toggleAccount(u)}><WorkspaceText style={s.secondaryActionText}>{u.active?'Deactivate':'Activate'}</WorkspaceText></Pressable>
              <Pressable style={s.dangerAction} onPress={()=>deleteAccount(Number(u.local_user_id),u.email)}><WorkspaceText style={s.dangerActionText}>Delete account</WorkspaceText></Pressable>
            </View>}
            {u.authentication_exists!==false&&roleMenuUser===Number(u.local_user_id)&&<View style={s.roleOptions}>{(['student','librarian','manager','administrator'] as const).map(role=><Pressable key={role} style={[s.roleOption,u.role===role&&s.roleOptionSelected]} onPress={()=>setAccountRole(u,role)}><WorkspaceText style={[s.roleOptionText,u.role===role&&s.roleOptionTextSelected]}>{role}</WorkspaceText></Pressable>)}</View>}
            {u.authentication_exists===false&&<WorkspaceText style={s.deletedNote}>Sign-in removed · library profile and history retained</WorkspaceText>}
          </View>)}
        </View>
        {!!security&&<View style={s.sectionCard}><View style={s.adminListHead}><SectionHeading title="Account security" subtitle={security.email}/><Pressable onPress={()=>setSecurity(null)}><WorkspaceText style={s.inlineLinkText}>Close</WorkspaceText></Pressable></View>
          <SecurityRow label="Role" value={security.role}/><SecurityRow label="Hashing method" value={security.hashingAlgorithm}/><SecurityRow label="Hash parameters" value={JSON.stringify(security.parameters||{})}/><SecurityRow label="Password hash" value={security.passwordHash}/><SecurityRow label="Individual salt" value={security.salt}/><SecurityRow label="Two-factor authentication" value={security.twoFactorEnabled?'Enabled':'Not enabled'}/><SecurityRow label="Password changed" value={security.passwordChangedAt?new Date(security.passwordChangedAt).toLocaleString():'—'}/>
          <WorkspaceText style={s.securityNote}>Pepper is a server-only secret and is intentionally not displayed or sent to the app.</WorkspaceText>
        </View>}
        <View style={s.sectionCard}><SectionHeading title="Authentication audit" subtitle="Account creation, role changes, sign-in activity, and deletions are recorded here."/>
          {!auditLogs.length&&<EmptyState message="No authentication events found."/>}
          {auditLogs.map((log:any)=><View key={log.id} style={s.auditRow}><View style={s.auditTop}><WorkspaceText style={s.auditAction}>{log.action}</WorkspaceText><StatusBadge label={log.status||'Recorded'} danger={log.status==='FAILURE'}/></View><WorkspaceText style={s.bodyText}>{log.details||'—'}</WorkspaceText><WorkspaceText style={s.metaText}>{log.user_email||'System'} · {log.timestamp?new Date(log.timestamp).toLocaleString():'—'}</WorkspaceText></View>)}
        </View>
      </>}

      <View style={s.footer}><WorkspaceText style={s.footerText}>Library Management System</WorkspaceText><Pressable style={s.refresh} onPress={search} accessibilityRole="button"><WorkspaceText style={s.refreshText}>{busy?'Refreshing…':'Refresh'}</WorkspaceText></Pressable></View>
      <Pressable style={[s.updateButton,updating&&{opacity:.65}]} onPress={checkForUpdates} disabled={updating} accessibilityRole="button"><WorkspaceText style={s.updateButtonText}>{updating?'Checking for updates…':'Check for updates'}</WorkspaceText></Pressable>
      <Pressable style={s.logoutButton} onPress={logout} accessibilityRole="button"><WorkspaceText style={s.logoutText}>Log out</WorkspaceText></Pressable>
    </View>
  </ScrollView>;
}

function WorkspaceText(props: import('react-native').TextProps) { const resolved=StyleSheet.flatten(props.style)||{}; const weight=Number(resolved.fontWeight)||400; const family=weight>=650?'CreatoDisplayBold':weight>=500?'CreatoDisplayMedium':'CreatoDisplay'; return <Text {...props} style={[props.style,{fontFamily:family,fontWeight:'normal',fontSize:Math.max(14,resolved.fontSize||16)}]}/>; }
function BrandMark({large=false}:{large?:boolean}) { return <View style={[s.brandMark,large&&s.brandMarkLarge]}><View style={s.bookLeft}/><View style={s.bookRight}/><View style={s.bookSpine}/></View>; }
function SectionHeading({title,subtitle}:{title:string;subtitle:string}) { return <View style={s.sectionHead}><WorkspaceText style={s.sectionTitleMain}>{title}</WorkspaceText><WorkspaceText style={s.sectionSubtitle}>{subtitle}</WorkspaceText></View>; }
function EmptyState({message}:{message:string}) { return <View style={s.empty}><WorkspaceText style={s.bodyText}>{message}</WorkspaceText></View>; }
function SecurityRow({label,value}:{label:string;value?:string|null}) { return <View style={s.securityRow}><WorkspaceText style={s.securityLabel}>{label}</WorkspaceText><WorkspaceText selectable style={s.securityValue}>{value||'—'}</WorkspaceText></View>; }
function StatusBadge({label,danger=false}:{label:string;danger?:boolean}) { return <View style={[s.statusBadge,danger&&s.statusBadgeDanger]}><WorkspaceText style={[s.statusText,danger&&s.statusTextDanger]}>{label}</WorkspaceText></View>; }
function BookCard({book,index,columns,onPress}:{book:Book;index:number;columns:number;onPress:()=>void}) {
  const colors=COVER_COLORS[index%COVER_COLORS.length];
  const isbn=book.isbn?.replace(/[^0-9Xx]/g,'');
  const coverUrl=isbn?`https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`:'';
  const [coverFailed,setCoverFailed]=useState(!coverUrl);
  return <Pressable style={[s.bookCard,{width:columns===3?'31.5%':'48.5%'}]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open details for ${book.title}`}>
    <View style={[s.cover,{backgroundColor:colors[0]}]}>
      {!coverFailed&&<Image source={{uri:coverUrl}} style={StyleSheet.absoluteFill} resizeMode="cover" onError={()=>setCoverFailed(true)}/>}
      {coverFailed&&<><View style={[s.coverGlow,{backgroundColor:colors[1]}]}/><View style={[s.coverBand,{backgroundColor:colors[2]}]}/><View style={s.coverInset}><WorkspaceText style={s.coverEyebrow}>THE LIBRARY COLLECTION</WorkspaceText><WorkspaceText numberOfLines={3} style={s.coverTitle}>{book.title}</WorkspaceText><View style={s.coverRule}/><WorkspaceText numberOfLines={1} style={s.coverAuthor}>{book.author}</WorkspaceText></View></>}
      <View style={s.coverSpine}/>
    </View>
    <View style={s.bookInfo}><WorkspaceText style={s.categoryText} numberOfLines={1}>{book.category||'General collection'}</WorkspaceText><WorkspaceText style={s.bookTitle} numberOfLines={2}>{book.title}</WorkspaceText><WorkspaceText style={s.bookAuthor} numberOfLines={1}>{book.author}</WorkspaceText>
      <View style={s.formatRow}>{(book.formats||['physical']).map(f=><View key={f} style={[s.formatChip,f==='ebook'&&s.ebookChip]}><WorkspaceText style={[s.formatText,f==='ebook'&&s.ebookText]}>{f==='ebook'?'eBook':'Physical'}</WorkspaceText></View>)}</View>
      <View style={s.stockRow}><View style={s.stockCell}><WorkspaceText style={s.stockValue}>{book.availablePhysicalCopies??book.availableCopies}/{book.physicalCopies??book.totalCopies}</WorkspaceText><WorkspaceText style={s.stockLabel}>Physical</WorkspaceText></View><View style={s.stockCell}><WorkspaceText style={s.stockValue}>{book.availableEbookLicenses||0}/{book.ebookLicenses||0}</WorkspaceText><WorkspaceText style={s.stockLabel}>eBook licenses</WorkspaceText></View></View>
      <WorkspaceText style={s.bookOpenHint}>View details &amp; borrow →</WorkspaceText>
    </View>
  </Pressable>;
}
function Button({label,onPress,disabled=false,workspace=false}:{label:string;onPress:()=>void;disabled?:boolean;workspace?:boolean}) { return <Pressable style={[s.button,disabled&&{opacity:.55}]} disabled={disabled} onPress={onPress}>{disabled?<ActivityIndicator color="#fff"/>:workspace?<WorkspaceText style={s.buttonText}>{label}</WorkspaceText>:<Text style={s.buttonText}>{label}</Text>}</Pressable>; }

const s=StyleSheet.create({
  scroll:{flex:1,backgroundColor:C.bg},page:{flexGrow:1,alignItems:'center',paddingHorizontal:14,paddingTop:16,paddingBottom:32},appPage:{flexGrow:1,alignItems:'center',paddingHorizontal:14,paddingTop:16,paddingBottom:30},shell:{width:'100%',maxWidth:1000,alignSelf:'center'},
  loginCard:{width:'100%',alignSelf:'center',marginTop:24,padding:28,borderRadius:26,backgroundColor:C.card,alignItems:'stretch',elevation:5,shadowColor:'#536b80',shadowOffset:{width:0,height:9},shadowOpacity:.15,shadowRadius:18},brandMark:{width:42,height:42,borderRadius:14,backgroundColor:C.navy,justifyContent:'center',alignItems:'center',flexDirection:'row',overflow:'hidden',marginRight:12},brandMarkLarge:{width:68,height:68,borderRadius:22,alignSelf:'center',marginHorizontal:0,marginBottom:22},bookLeft:{width:10,height:17,borderTopLeftRadius:2,borderBottomLeftRadius:2,backgroundColor:'#fff8e8',transform:[{skewY:'-10deg'}]},bookRight:{width:10,height:17,borderTopRightRadius:2,borderBottomRightRadius:2,backgroundColor:'#e6c98e',transform:[{skewY:'10deg'}]},bookSpine:{position:'absolute',width:2,height:17,backgroundColor:C.navy},
  loginEyebrow:{textAlign:'center',fontSize:11,fontWeight:'800',letterSpacing:1.6,color:C.blue,marginBottom:7},loginTitle:{textAlign:'center',fontSize:27,fontWeight:'800',color:C.dark},loginIntro:{textAlign:'center',fontSize:14,lineHeight:21,color:C.muted,marginTop:5,marginBottom:22},loginFoot:{textAlign:'center',fontSize:12,color:C.muted,marginTop:19},label:{fontSize:13,fontWeight:'700',color:C.dark,marginTop:9,marginBottom:3},
  headerCard:{padding:18,borderRadius:18,backgroundColor:'#fff',borderWidth:1,borderColor:'#e7e8ef',flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8,elevation:2,shadowColor:'#171923',shadowOffset:{width:0,height:5},shadowOpacity:.08,shadowRadius:13},brandRow:{flexDirection:'row',alignItems:'center',flex:1,minWidth:0},brandCopy:{flex:1,minWidth:0},headerTitle:{fontSize:19,fontWeight:'800',color:'#171923',flexShrink:1},headerWelcome:{fontSize:13,color:'#777987',marginTop:3,flexShrink:1},roleBadge:{paddingHorizontal:11,paddingVertical:7,borderRadius:20,backgroundColor:'#f0f1ff',borderWidth:1,borderColor:'#dfe2ff',maxWidth:120},roleBadgeText:{fontSize:10,fontWeight:'800',letterSpacing:.5,textTransform:'uppercase',color:'#263cff'},
  nav:{marginVertical:12,flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',gap:7,padding:3},navItem:{paddingVertical:10,paddingHorizontal:8,borderRadius:10,alignItems:'center',justifyContent:'center',backgroundColor:'#fff',borderWidth:1,borderColor:'#e7e8ef'},navItemActive:{backgroundColor:'#263cff',borderColor:'#263cff'},navText:{fontSize:13,fontWeight:'700',color:'#626472',textAlign:'center'},navTextActive:{color:'#fff'},
  sectionCard:{padding:18,borderRadius:18,backgroundColor:'#fff',borderWidth:1,borderColor:'#e7e8ef',marginBottom:16,elevation:2,shadowColor:'#171923',shadowOffset:{width:0,height:4},shadowOpacity:.07,shadowRadius:12},sectionHead:{marginBottom:13},sectionTitleMain:{fontSize:21,fontWeight:'800',color:'#171923'},sectionSubtitle:{fontSize:13,lineHeight:19,color:'#777987',marginTop:4},sectionTitle:{fontSize:16,fontWeight:'800',color:'#171923',marginTop:16,marginBottom:7},searchRow:{flexDirection:'row',alignItems:'center',gap:8},workspaceInput:{fontFamily:'CreatoDisplay',fontSize:16},input:{width:'100%',backgroundColor:'#f8f9fc',borderColor:'#e7e8ef',borderWidth:1,borderRadius:11,paddingHorizontal:14,paddingVertical:13,marginVertical:7,color:'#171923',fontSize:14},searchInput:{flex:1,minWidth:0,marginVertical:0},searchButton:{minHeight:47,paddingHorizontal:16,borderRadius:10,backgroundColor:'#263cff',alignItems:'center',justifyContent:'center'},searchButtonText:{fontSize:13,fontWeight:'800',color:'#fff'},countText:{fontSize:12,fontWeight:'700',color:'#777987',marginTop:13,marginBottom:3},bookGrid:{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',rowGap:11,marginTop:7},
  bookCard:{overflow:'hidden',borderRadius:14,backgroundColor:'#fff',borderWidth:1,borderColor:'#e7e8ef',elevation:2,shadowColor:'#171923',shadowOffset:{width:0,height:4},shadowOpacity:.07,shadowRadius:9},cover:{width:'100%',aspectRatio:.82,overflow:'hidden',justifyContent:'center'},coverGlow:{position:'absolute',width:155,height:155,borderRadius:80,top:-61,right:-49,opacity:.65},coverBand:{position:'absolute',width:'150%',height:85,bottom:-37,left:-22,transform:[{rotate:'-12deg'}],opacity:.55},coverInset:{paddingHorizontal:14,paddingVertical:16,flex:1,justifyContent:'space-between'},coverEyebrow:{fontSize:7,fontWeight:'800',letterSpacing:1.5,color:'rgba(255,255,255,.8)'},coverTitle:{marginTop:14,fontSize:19,lineHeight:23,fontWeight:'800',color:'#fff',fontFamily:'Georgia'},coverRule:{width:38,height:2,backgroundColor:'rgba(255,255,255,.72)',marginTop:5},coverAuthor:{fontSize:10,fontWeight:'600',color:'rgba(255,255,255,.9)',marginTop:'auto'},coverSpine:{position:'absolute',left:8,top:0,bottom:0,width:2,backgroundColor:'rgba(255,255,255,.22)'},bookInfo:{padding:10},categoryText:{fontSize:8,fontWeight:'800',letterSpacing:.8,textTransform:'uppercase',color:'#777987'},bookTitle:{fontSize:13,fontWeight:'800',lineHeight:18,color:'#202230',marginTop:4},bookAuthor:{fontSize:11,color:'#777987',marginTop:3},formatRow:{flexDirection:'row',flexWrap:'wrap',gap:4,marginTop:8},formatChip:{borderRadius:10,paddingHorizontal:7,paddingVertical:4,backgroundColor:'#eff0ff'},ebookChip:{backgroundColor:'#edf5ee'},formatText:{fontSize:9,fontWeight:'700',color:'#3346dc'},ebookText:{color:C.green},stockRow:{flexDirection:'row',borderTopWidth:1,borderColor:'#e7e8ef',marginTop:9,paddingTop:7},stockCell:{flex:1},stockValue:{fontSize:11,fontWeight:'800',color:'#303246'},stockLabel:{fontSize:8,color:'#777987',marginTop:2},bookOpenHint:{borderTopWidth:1,borderColor:'#e7e8ef',marginTop:9,paddingTop:8,fontSize:9,fontWeight:'800',color:'#263cff'},
  loanCard:{padding:14,borderRadius:13,backgroundColor:'#fafaff',borderWidth:1,borderColor:'#e7e8ef',marginVertical:6},loanHead:{flexDirection:'row',alignItems:'flex-start',justifyContent:'space-between',gap:8},loanTitle:{flex:1,fontSize:15,fontWeight:'800',lineHeight:21,color:'#202230'},bodyText:{fontSize:13,lineHeight:19,color:'#626472',marginTop:4},metaText:{fontSize:11,lineHeight:17,color:'#777987',marginTop:5},statusBadge:{alignSelf:'flex-start',paddingHorizontal:9,paddingVertical:5,borderRadius:12,backgroundColor:'#eaf5ef'},statusBadgeDanger:{backgroundColor:'#fff0ef'},statusText:{fontSize:10,fontWeight:'800',color:C.green},statusTextDanger:{color:C.red},inlineLink:{alignSelf:'flex-start',marginTop:9},inlineLinkText:{fontSize:13,fontWeight:'800',color:'#263cff'},userRow:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:10,borderBottomWidth:1,borderColor:'#e7e8ef'},userAvatar:{width:38,height:38,borderRadius:19,backgroundColor:'#eff0ff',alignItems:'center',justifyContent:'center'},userInitial:{fontSize:15,fontWeight:'800',color:'#263cff'},userInfo:{flex:1},userName:{fontSize:13,fontWeight:'700',color:'#202230'},metricsGrid:{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',rowGap:10},metricCard:{minHeight:92,padding:14,borderRadius:13,backgroundColor:'#fafaff',borderWidth:1,borderColor:'#e7e8ef',justifyContent:'center'},metricValue:{fontSize:24,fontWeight:'800',color:'#263cff'},metricDanger:{color:C.red},metricLabel:{fontSize:11,fontWeight:'600',color:'#777987',marginTop:3},adminInfo:{padding:14,marginTop:16,borderRadius:13,backgroundColor:'#f5f5ff'},adminInfoTitle:{fontSize:12,fontWeight:'800',color:'#202230'},
  adminListHead:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8},adminUserCard:{padding:13,marginTop:9,borderRadius:15,backgroundColor:'rgba(247,249,252,.9)',borderWidth:1,borderColor:'#e5ebf0'},adminUserTop:{flexDirection:'row',alignItems:'center',gap:10},userBadges:{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:7,marginTop:7},roleText:{fontSize:10,fontWeight:'800',color:C.navy,textTransform:'capitalize'},roleOptions:{flexDirection:'row',flexWrap:'wrap',gap:7,marginTop:11},roleOption:{paddingHorizontal:11,paddingVertical:8,borderRadius:10,borderWidth:1,borderColor:C.line,backgroundColor:'#fff'},roleOptionSelected:{borderColor:C.blue,backgroundColor:'#eaf2fa'},roleOptionText:{fontSize:11,fontWeight:'700',color:C.dark,textTransform:'capitalize'},roleOptionTextSelected:{color:C.blue},actionGrid:{flexDirection:'row',flexWrap:'wrap',gap:7,marginTop:12},secondaryAction:{width:'48%',minHeight:40,paddingHorizontal:9,paddingVertical:9,borderRadius:10,backgroundColor:'#eaf2fa',alignItems:'center',justifyContent:'center'},secondaryActionText:{fontSize:11,fontWeight:'800',color:C.navy,textAlign:'center'},dangerAction:{width:'48%',minHeight:40,paddingHorizontal:9,paddingVertical:9,borderRadius:10,backgroundColor:'#fff0ef',alignItems:'center',justifyContent:'center'},dangerActionText:{fontSize:11,fontWeight:'800',color:C.red,textAlign:'center'},deletedNote:{fontSize:11,lineHeight:17,color:C.muted,marginTop:10},securityRow:{paddingVertical:10,borderBottomWidth:1,borderColor:C.line},securityLabel:{fontSize:11,fontWeight:'800',color:C.muted,textTransform:'uppercase',letterSpacing:.4},securityValue:{fontSize:12,lineHeight:18,color:C.dark,marginTop:4,fontFamily:'monospace'},securityNote:{fontSize:11,lineHeight:17,color:C.muted,marginTop:12},auditRow:{paddingVertical:11,borderBottomWidth:1,borderColor:C.line},auditTop:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8},auditAction:{flex:1,fontSize:12,fontWeight:'800',color:C.dark},
  empty:{padding:18,borderRadius:15,backgroundColor:'rgba(247,249,252,.85)',alignItems:'center',marginTop:8},emptyTitle:{fontSize:15,fontWeight:'800',color:C.dark},footer:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:4,paddingVertical:9},footerText:{fontSize:11,color:C.muted},refresh:{paddingHorizontal:12,paddingVertical:8,borderRadius:11,backgroundColor:'#f1f5f8'},refreshText:{fontSize:12,fontWeight:'700',color:C.blue},updateButton:{alignSelf:'stretch',alignItems:'center',justifyContent:'center',minHeight:48,padding:12,marginTop:5,marginBottom:8,borderRadius:13,backgroundColor:C.navy},updateButtonText:{color:'#fff',fontWeight:'800',fontSize:14},logoutButton:{alignSelf:'stretch',alignItems:'center',justifyContent:'center',minHeight:48,padding:12,marginTop:5,marginBottom:12,borderRadius:13,borderWidth:1,borderColor:'#efcaca',backgroundColor:'#fff5f5'},logoutText:{color:C.red,fontWeight:'800',fontSize:14},
  button:{backgroundColor:C.blue,padding:14,borderRadius:13,alignItems:'center',marginTop:10,minHeight:48,justifyContent:'center',width:'100%'},buttonText:{color:'#fff',fontWeight:'800',fontSize:14},error:{color:C.red,backgroundColor:'#fff0ef',borderRadius:12,padding:12,marginVertical:8,fontSize:13,lineHeight:19,overflow:'hidden'},success:{color:C.green,backgroundColor:'#eaf5ef',borderRadius:12,padding:12,marginVertical:8,fontSize:13},link:{color:C.blue,fontWeight:'800',padding:12,textAlign:'center'},enroll:{alignItems:'center',padding:14,backgroundColor:'#f2f6fa',borderRadius:16,marginVertical:12,width:'100%'},qr:{width:170,height:170,margin:10},codeText:{fontFamily:'monospace',color:C.dark,marginVertical:3,flexShrink:1},
});

