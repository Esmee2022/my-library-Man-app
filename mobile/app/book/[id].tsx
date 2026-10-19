import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { readAuth, request, type Auth } from '../../lib/api';

type Book = {
  id: string; title: string; author: string; isbn?: string; category?: string;
  publisher?: string; publication_year?: number; description?: string; formats?: string[];
  physicalCopies: number; availablePhysicalCopies: number; ebookLicenses: number; availableEbookLicenses: number;
};
type ActiveLoan = { id: string; format: string; dueAt: string; ebookUrl?: string | null };
type ReaderProfile = { role: string; display_name: string; email: string };
const COLORS = ['#173f5f','#20639b','#3caea3'];
const C = {blue:'#263cff',navy:'#171923',dark:'#171923',muted:'#777987',bg:'#f2f3f8',card:'#fff',line:'#e7e8ef',green:'#23734b',red:'#b42318'};

function WorkspaceText(props: import('react-native').TextProps) { const resolved=StyleSheet.flatten(props.style)||{}; const weight=Number(resolved.fontWeight)||400; const family=weight>=650?'CreatoDisplayBold':weight>=500?'CreatoDisplayMedium':'CreatoDisplay'; return <Text {...props} style={[props.style,{fontFamily:family,fontWeight:'normal',fontSize:Math.max(14,resolved.fontSize||16)}]}/>; }

export default function BookDetails() {
  const { id } = useLocalSearchParams<{id:string}>();
  const router = useRouter();
  const [auth,setAuth] = useState<Auth|null>(null);
  const [profile,setProfile] = useState<ReaderProfile|null>(null);
  const [book,setBook] = useState<Book|null>(null);
  const [activeLoans,setActiveLoans] = useState<ActiveLoan[]>([]);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [info,setInfo] = useState('');
  const [coverFailed,setCoverFailed] = useState(false);

  async function loadDetails(session:Auth) {
    const [who,details] = await Promise.all([request('/library/me',session),request(`/library/books/${encodeURIComponent(String(id || ''))}`,session)]);
    setProfile(who.user);
    setBook(details.book);
    setActiveLoans(details.myActiveLoans || []);
    setCoverFailed(false);
  }

  useEffect(()=>{
    let mounted=true;
    (async()=>{
      setLoading(true);setError('');
      try {
        const session=await readAuth();
        if(!session){router.replace('/');return;}
        if(!mounted)return;
        setAuth(session);
        const [who,details]=await Promise.all([request('/library/me',session),request(`/library/books/${encodeURIComponent(String(id || ''))}`,session)]);
        if(!mounted)return;
        setProfile(who.user);setBook(details.book);setActiveLoans(details.myActiveLoans||[]);
      } catch(e:any) {
        if(mounted){setError(e.message||'Could not load this book.');setBook(null);}
      } finally {if(mounted)setLoading(false);}
    })();
    return ()=>{mounted=false;};
  },[id]);

  async function borrow(format:'physical'|'ebook') {
    if(!auth||!book||busy)return;
    setBusy(true);setError('');setInfo('');
    try {
      await request(`/library/books/${encodeURIComponent(book.id)}/borrow`,auth,{method:'POST',body:JSON.stringify({format})});
      await loadDetails(auth);
      setInfo(format==='ebook'?'eBook loan started. Use the reading button below to open it online.':'Your 14-day physical loan is active. Collect the book at the circulation desk.');
    } catch(e:any){setError(e.message||'Could not borrow this title. Please try again.');}
    finally{setBusy(false);}
  }

  async function openReader(url:string) {
    try {
      const parsed=new URL(url);
      if(parsed.protocol!=='https:')throw new Error('The reading link is not secure. Please contact library staff.');
      await Linking.openURL(parsed.href);
    } catch(e:any){setError(e.message||'No browser is available to open the eBook.');}
  }

  const activePhysical=activeLoans.find(loan=>loan.format==='physical');
  const activeEbook=activeLoans.find(loan=>loan.format==='ebook');
  const isbn=book?.isbn?.replace(/[^0-9Xx]/g,'');
  const coverUri=isbn?`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`:'';

  if(loading)return <View style={s.center}><ActivityIndicator size="large" color={C.blue}/><WorkspaceText style={s.loadingText}>Loading book details…</WorkspaceText></View>;
  if(!book)return <View style={s.center}><WorkspaceText style={s.errorTitle}>Book unavailable</WorkspaceText><WorkspaceText style={s.copy}>{error||'This title is no longer in the catalogue.'}</WorkspaceText><Pressable style={s.backButton} onPress={()=>router.back()}><WorkspaceText style={s.backButtonText}>Back to catalogue</WorkspaceText></Pressable></View>;

  return <ScrollView style={s.screen} contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <View style={s.shell}>
      <Pressable style={s.backLink} onPress={()=>router.back()} accessibilityRole="button"><WorkspaceText style={s.backLinkText}>‹  Catalogue</WorkspaceText></Pressable>
      <View style={s.card}>
        <View style={[s.cover,{backgroundColor:COLORS[0]}]}>
          {!coverFailed&&!!coverUri&&<Image source={{uri:coverUri}} style={StyleSheet.absoluteFill} resizeMode="cover" onError={()=>setCoverFailed(true)}/>}
          {coverFailed||!coverUri?<><View style={s.coverOrb}/><View style={s.coverCopy}><WorkspaceText style={s.coverEyebrow}>LIBRARY COLLECTION</WorkspaceText><WorkspaceText style={s.coverTitle}>{book.title}</WorkspaceText><View style={s.coverRule}/><WorkspaceText style={s.coverAuthor}>{book.author}</WorkspaceText></View></>:null}
        </View>
        <WorkspaceText style={s.category}>{book.category||'General collection'}</WorkspaceText>
        <WorkspaceText style={s.title}>{book.title}</WorkspaceText>
        <WorkspaceText style={s.author}>by {book.author}</WorkspaceText>
        <View style={s.formats}>{(book.formats||[]).map(format=><View key={format} style={[s.chip,format==='ebook'&&s.ebookChip]}><WorkspaceText style={[s.chipText,format==='ebook'&&s.ebookText]}>{format==='ebook'?'eBook':'Physical book'}</WorkspaceText></View>)}</View>
        <WorkspaceText style={s.description}>{book.description||'No description is available for this title yet.'}</WorkspaceText>
        <View style={s.metadata}>
          <Meta label="Publisher" value={book.publisher}/><Meta label="Published" value={book.publication_year?String(book.publication_year):undefined}/>
          <Meta label="ISBN" value={book.isbn}/><Meta label="Category" value={book.category}/>
        </View>
        <WorkspaceText style={s.sectionTitle}>Availability</WorkspaceText>
        <View style={s.availability}><WorkspaceText style={s.availabilityLabel}>Physical copies</WorkspaceText><WorkspaceText style={s.availabilityCount}>{book.availablePhysicalCopies} / {book.physicalCopies}</WorkspaceText></View>
        <View style={s.availability}><WorkspaceText style={s.availabilityLabel}>eBook licenses</WorkspaceText><WorkspaceText style={s.availabilityCount}>{book.availableEbookLicenses} / {book.ebookLicenses}</WorkspaceText></View>
        {!!error&&<WorkspaceText style={s.error}>{error}</WorkspaceText>}{!!info&&<WorkspaceText style={s.success}>{info}</WorkspaceText>}
        {profile?.role==='student'?<View style={s.actions}>
          {activePhysical?<View style={s.loanNote}><WorkspaceText style={s.loanTitle}>Physical copy checked out to you</WorkspaceText><WorkspaceText style={s.loanCopy}>Due {new Date(activePhysical.dueAt).toLocaleDateString()}. Collect your copy at the circulation desk.</WorkspaceText></View>:book.formats?.includes('physical')?<Action label={book.availablePhysicalCopies?'Borrow physical copy · 14 days':'No physical copies available'} onPress={()=>borrow('physical')} disabled={!book.availablePhysicalCopies||busy} secondary={false}/>:null}
          {activeEbook?.ebookUrl?<Action label="Continue reading online" onPress={()=>openReader(activeEbook.ebookUrl!)} disabled={busy}/>:activeEbook?<View style={s.loanNote}><WorkspaceText style={s.loanTitle}>Your eBook loan is active</WorkspaceText><WorkspaceText style={s.loanCopy}>The library needs to update its secure reading link. Contact library staff.</WorkspaceText></View>:book.formats?.includes('ebook')?<Action label={book.availableEbookLicenses?'Borrow eBook license & read online':'No eBook licenses available'} onPress={()=>borrow('ebook')} disabled={!book.availableEbookLicenses||busy} secondary/>:null}
        </View>:<View style={s.loanNote}><WorkspaceText style={s.loanTitle}>{profile?.role==='librarian'||profile?.role==='administrator'?'Circulation desk':'Student access required'}</WorkspaceText><WorkspaceText style={s.loanCopy}>{profile?.role==='librarian'||profile?.role==='administrator'?'Use the circulation workspace to issue this title to a reader.':'Sign in with an active student library account to borrow this title.'}</WorkspaceText></View>}
        <WorkspaceText style={s.footnote}>eBooks open through the secure reading provider supplied by the library. Physical loans are recorded for 14 days and should be collected at the circulation desk.</WorkspaceText>
      </View>
    </View>
  </ScrollView>;
}

function Meta({label,value}:{label:string;value?:string}){return <View style={s.meta}><WorkspaceText style={s.metaLabel}>{label}</WorkspaceText><WorkspaceText style={s.metaValue}>{value||'Not provided'}</WorkspaceText></View>;}
function Action({label,onPress,disabled,secondary=false}:{label:string;onPress:()=>void;disabled:boolean;secondary?:boolean}){return <Pressable style={[s.action,secondary&&s.actionSecondary,disabled&&s.disabled]} onPress={onPress} disabled={disabled} accessibilityRole="button"><WorkspaceText style={[s.actionText,secondary&&s.actionSecondaryText]}>{disabled&&label.startsWith('Borrow')?'Please wait…':label}</WorkspaceText></Pressable>;}

const s=StyleSheet.create({
  screen:{flex:1,backgroundColor:C.bg},page:{padding:15,paddingBottom:36,alignItems:'center'},shell:{width:'100%',maxWidth:760},center:{flex:1,alignItems:'center',justifyContent:'center',padding:28,backgroundColor:C.bg},loadingText:{marginTop:12,color:C.muted,fontSize:14},errorTitle:{color:C.dark,fontSize:22,fontWeight:'800'},copy:{color:C.muted,fontSize:14,textAlign:'center',lineHeight:21,marginTop:8},backButton:{marginTop:20,padding:14,borderRadius:12,backgroundColor:C.blue},backButtonText:{color:'#fff',fontWeight:'800'},backLink:{alignSelf:'flex-start',paddingVertical:8,marginBottom:6},backLinkText:{fontSize:14,fontWeight:'800',color:C.blue},card:{padding:18,borderRadius:18,backgroundColor:C.card,borderWidth:1,borderColor:C.line,elevation:2,shadowColor:'#171923',shadowOffset:{width:0,height:5},shadowOpacity:.08,shadowRadius:13},cover:{height:330,width:'100%',maxWidth:360,alignSelf:'center',borderRadius:15,overflow:'hidden',justifyContent:'flex-end',marginBottom:20},coverOrb:{position:'absolute',width:210,height:210,borderRadius:110,top:-65,right:-60,backgroundColor:COLORS[1],opacity:.8},coverCopy:{padding:22,flex:1,justifyContent:'flex-end',backgroundColor:'rgba(20,40,58,.22)'},coverEyebrow:{color:'rgba(255,255,255,.8)',fontSize:9,fontWeight:'800',letterSpacing:1.6,marginBottom:12},coverTitle:{fontSize:30,lineHeight:35,fontWeight:'800',color:'#fff'},coverRule:{width:48,height:2,backgroundColor:'rgba(255,255,255,.75)',marginTop:12},coverAuthor:{color:'rgba(255,255,255,.9)',fontSize:14,fontWeight:'600',marginTop:12},category:{fontSize:10,fontWeight:'800',letterSpacing:1.2,color:C.blue,textTransform:'uppercase'},title:{fontSize:27,lineHeight:33,color:C.dark,fontWeight:'800',marginTop:4},author:{fontSize:15,color:C.muted,marginTop:7},formats:{flexDirection:'row',flexWrap:'wrap',gap:7,marginTop:14},chip:{paddingHorizontal:11,paddingVertical:6,borderRadius:20,backgroundColor:'#eff0ff'},ebookChip:{backgroundColor:'#eaf5ef'},chipText:{fontSize:11,fontWeight:'800',color:C.navy},ebookText:{color:C.green},description:{fontSize:14,lineHeight:22,color:'#626472',marginTop:18},metadata:{flexDirection:'row',flexWrap:'wrap',gap:8,marginTop:18},meta:{width:'48%',padding:12,borderRadius:11,borderWidth:1,borderColor:C.line,backgroundColor:'#f8f9fc'},metaLabel:{fontSize:9,color:C.muted,fontWeight:'800',letterSpacing:.6,textTransform:'uppercase'},metaValue:{fontSize:12,color:C.dark,fontWeight:'700',marginTop:5,flexShrink:1},sectionTitle:{fontSize:16,color:C.dark,fontWeight:'800',marginTop:22,marginBottom:6},availability:{flexDirection:'row',justifyContent:'space-between',paddingVertical:11,borderBottomWidth:1,borderColor:C.line},availabilityLabel:{fontSize:13,color:C.muted},availabilityCount:{fontSize:13,color:C.navy,fontWeight:'800'},actions:{gap:10,marginTop:16},action:{minHeight:49,paddingHorizontal:15,paddingVertical:13,borderRadius:10,backgroundColor:C.blue,alignItems:'center',justifyContent:'center'},actionSecondary:{backgroundColor:'#eff0ff'},actionText:{fontSize:13,fontWeight:'800',color:'#fff',textAlign:'center'},actionSecondaryText:{color:C.blue},disabled:{opacity:.55},loanNote:{padding:13,borderRadius:12,backgroundColor:'#eaf5ef'},loanTitle:{fontSize:13,fontWeight:'800',color:C.green},loanCopy:{fontSize:12,lineHeight:18,color:'#587365',marginTop:4},footnote:{fontSize:11,lineHeight:17,color:C.muted,marginTop:17},error:{padding:11,borderRadius:10,backgroundColor:'#fff0ef',color:C.red,fontSize:12,marginTop:12},success:{padding:11,borderRadius:10,backgroundColor:'#eaf5ef',color:C.green,fontSize:12,marginTop:12}
});
