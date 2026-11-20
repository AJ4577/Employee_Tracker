import { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  pin: { lat: number; lon: number; label: string; approximate: boolean } | null;
  me?: { lat: number; lon: number; accuracy_m: number } | null;
  tileUrl: string;
  attribution: string;
  height?: number;
}

/**
 * Leaflet inside a WebView (no Google Maps SDK key required). Shows the farmer pin and, if
 * known, the device position. Search inside the map only pans the view; it never changes the pin.
 */
function html({ pin, me, tileUrl, attribution }: Props) {
  const data = JSON.stringify({ pin, me, tileUrl, attribution });
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" crossorigin="anonymous" referrerpolicy="no-referrer"/>
<style>html,body,#m{margin:0;height:100%;}</style></head><body><div id="m"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
var d=${data.replace(/</g, "\\u003c")};
var map=L.map('m',{zoomControl:true});
L.tileLayer(d.tileUrl,{maxZoom:19,attribution:d.attribution}).addTo(map);
var pts=[];
if(d.pin){L.circleMarker([d.pin.lat,d.pin.lon],{radius:10,color:'#fff',weight:3,fillColor:d.pin.approximate?'#e0a100':'#1f6f3a',fillOpacity:1}).addTo(map).bindPopup(document.createTextNode(d.pin.label+(d.pin.approximate?' (approximate)':'')).textContent);pts.push([d.pin.lat,d.pin.lon]);}
if(d.me){L.circle([d.me.lat,d.me.lon],{radius:d.me.accuracy_m,color:'#1d6fd6',weight:1,fillOpacity:.1}).addTo(map);L.circleMarker([d.me.lat,d.me.lon],{radius:7,color:'#fff',weight:2,fillColor:'#1d6fd6',fillOpacity:1}).addTo(map);pts.push([d.me.lat,d.me.lon]);}
if(pts.length>1)map.fitBounds(pts,{padding:[30,30],maxZoom:16});else if(pts.length)map.setView(pts[0],15);else map.setView([20.59,78.96],5);
</script></body></html>`;
}

export function MapWebView(props: Props) {
  const [full, setFull] = useState(false);
  const src = useMemo(() => ({ html: html(props) }), [props.pin?.lat, props.pin?.lon, props.me?.lat, props.me?.lon, props.tileUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = <WebView originWhitelist={["*"]} source={src} style={{ flex: 1 }} javaScriptEnabled setSupportMultipleWindows={false} />;
  return (
    <>
      <View style={[st.box, { height: props.height ?? 240 }]}>
        {view}
        <Pressable style={st.fsBtn} onPress={() => setFull(true)} accessibilityRole="button" accessibilityLabel="Open full screen map">
          <Text style={st.fsText}>⤢ Full screen</Text>
        </Pressable>
      </View>
      <Modal visible={full} animationType="slide" onRequestClose={() => setFull(false)}>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>{view}</View>
          <Pressable style={st.close} onPress={() => setFull(false)} accessibilityRole="button" accessibilityLabel="Close map">
            <Text style={st.fsText}>✕ Close map</Text>
          </Pressable>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const st = StyleSheet.create({
  box: { borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: "#d9e3dc", marginBottom: 10 },
  fsBtn: { position: "absolute", top: 8, right: 8, backgroundColor: "#fff", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, elevation: 2 },
  close: { minHeight: 52, alignItems: "center", justifyContent: "center", backgroundColor: "#fff", borderTopWidth: 1, borderColor: "#d9e3dc" },
  fsText: { fontWeight: "700", color: "#12432a" },
});
