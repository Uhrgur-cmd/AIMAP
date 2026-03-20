/**
 * CTBase Companion Specification – Mapping Rules
 *
 * Describes the BEHAVIOR and TYPICAL IMPLEMENTATION of every CTBase signal.
 * These rules are generic – they describe WHAT a signal does, not what it's called.
 * The AI uses the dependency trees + these rules to find the right PLC signal.
 */

const CTBASE_RULES = `
=== CTBase MAPPING RULES ===
Jede Regel beschreibt das VERHALTEN des Signals und wie es typisch in einer SPS implementiert ist.
Nutze die Dependency Trees (← [...]) um Signale zu finden die dieses Verhalten zeigen.
Der Name in der SPS kann komplett anders sein – entscheidend ist die FUNKTION.

--- COMMUNICATION ---

Communication.HeartbeatUp [INT]: Lebenszeichen SPS → MES.
  VERHALTEN: Ein INT-Zähler der zyklisch inkrementiert wird (z.B. jede Sekunde +1). Dient zur Erkennung ob die SPS noch läuft.
  IMPLEMENTIERUNG: Wird in einem zyklischen OB (OB1/OB35) hochgezählt. Typisch: immer aktiv, unabhängig von Betriebsart.
  ERKENNUNG: INT/WORD der kontinuierlich hochzählt, keine Bedingung außer SPS läuft. Oft "Alive", "Heartbeat", "Puls", "LifeBit".

Communication.HeartbeatDown [INT]: Lebenszeichen MES → SPS.
  VERHALTEN: Wird von EXTERNEM System (MES/SCADA) geschrieben. SPS liest es nur.
  ERKENNUNG: INT/WORD der sich ändert ohne dass SPS-Logik ihn schreibt. Kein Writer im Dependency Tree.

Communication.HandshakeRealValues [BOOL]: Synchronisations-Bit für Datenaustausch.
  VERHALTEN: Wird gesetzt wenn Echtzeit-Werte zwischen SPS und MES ausgetauscht werden sollen.
  ERKENNUNG: BOOL das mit Kommunikations-Logik zusammenhängt. "Handshake", "DataValid", "DataReady".

Communication.DateTimeMES [STRING/LDT]: Zeitstempel vom MES-System.
  VERHALTEN: Wird von extern geschrieben, SPS nutzt es als Referenzzeit.
  ERKENNUNG: DATE_AND_TIME, LDT oder STRING mit Zeitformat. Kein Writer im Dependency Tree oder von Kommunikations-FB geschrieben.

--- ERROR MESSAGES ---

ErrorMessages.ErrorNumberPLC [INT]: Aktive Fehlernummer der SPS.
  VERHALTEN: Enthält die Nummer des aktuell niedrigsten aktiven Fehlers. 0 = kein Fehler. Wird von der Fehlerbehandlung geschrieben.
  IMPLEMENTIERUNG: Typisch ein Fehlerpuffer-FB der alle Störungen sammelt und die niedrigste aktive Nummer ausgibt.
  ERKENNUNG: INT der sich bei Störungsmeldungen ändert. Hängt ab von Störungs-Bits/Fehlerbausteinen. "ErrorNum", "Störungsnummer", "FaultCode", "Error_ID".

ErrorMessages.ErrorNumberMES [INT]: Fehlernummer vom MES.
  VERHALTEN: Wird von MES geschrieben wenn ein MES-Fehler vorliegt. 0 = kein Fehler.
  ERKENNUNG: INT ohne SPS-interne Abhängigkeiten. Von Kommunikations-FB empfangen.

ErrorMessages.ErrorDescription [STRING]: Fehlertext.
  VERHALTEN: Klartext-Beschreibung des aktuellen Fehlers. Generiert aus Alarmbaustein oder Fehlerliste.
  ERKENNUNG: STRING der sich bei Störungen ändert. Oft von einem Alarm-FB geschrieben. "ErrorText", "Störungstext", "AlarmText".

ErrorMessages.LogLevel [STRING]: Log-Level ('DEBUG'/'INFO'/'ERROR').
  VERHALTEN: Schaltet zwischen Detailgrad der Protokollierung um. Toggelt bei Schaltflanke.
  ERKENNUNG: STRING mit festen Werten. Oft von extern schaltbar.

--- MACHINE ---

Machine.MachineryItemState [STRING]: Maschinenzustand als Text.
  VERHALTEN: Wird BERECHNET aus mehreren Bedingungen. KEIN einzelnes PLC-Signal.
  REGELN (Priorität absteigend):
  1. 'Not available' – Kommunikationsfehler (Heartbeat-Timeout oder Verbindungsfehler)
  2. 'Out of Service - Blocked' – Partner-Ressource produziert, eigene Maschine nicht
  3. 'Out of Service' – Fehler aktiv UND nicht produzierend
  4. 'Executing' – Automatik-Modus UND produzierend UND Prozess nicht fertig
  5. 'Not Executing' – Maschine eingeschaltet aber produziert nicht
  ERKENNUNG: Kein direktes Signal. Expression aus ModeBits + StateBits + ErrorActive aufbauen.

Machine.MachineryOperationMode [STRING]: Betriebsmodus als Text.
  VERHALTEN: Wird BERECHNET aus Produktionsstatus und Rezept-Zustand.
  REGELN:
  1. 'None' – Default, kein spezieller Modus
  2. 'Setup' – Neues Rezept geladen ODER Auftragswechsel (Einrichten/Rüsten)
  3. 'Processing' – Aktiv produzierend (Automatik + Producing = true)
  4. 'Maintenance' – Wartungsmodus von extern gesetzt
  ERKENNUNG: Kein direktes Signal. Kombination aus Rezeptstatus + Produktionszustand.

Machine.MachineIsReleased [BOOL]: Maschine ist für Produktion freigegeben.
  VERHALTEN: TRUE wenn alle Voraussetzungen für Produktion erfüllt sind: kein Fehler, Rezept ok, Bediener bestätigt.
  IMPLEMENTIERUNG: Output eines Release-Handshakes zwischen SPS und MES. Wird gesetzt nach positiver MES-Rückmeldung.
  ERKENNUNG: BOOL das von mehreren Bedingungen abhängt (Fehler, Rezept, Kommunikation). "Freigabe", "Released", "MachineIsReleased".

Machine.MachineRelease [BOOL]: Freigabe-Befehl (MES → SPS).
  VERHALTEN: Impuls/Flanke von MES die eine Produktionsfreigabe erteilt. Löst einen Produktionszyklus aus.
  ERKENNUNG: BOOL das von extern gesetzt wird und intern als Flanke ausgewertet wird. "Release", "Start_Freigabe".

Machine.MachineResetRelease [BOOL]: Freigabe zurücksetzen.
  VERHALTEN: Setzt alle Freigaben und Zähler auf 0 zurück. Reset-Funktion.
  ERKENNUNG: BOOL das Zähler und Status-Bits zurücksetzt. "ResetRelease", "Reset_Freigabe".

Machine.MachineCancelEntity [BOOL]: Aktuelles Werkstück/Zyklus abbrechen.
  VERHALTEN: Bricht den laufenden Produktionszyklus ab. Das aktuelle Teil wird als Ausschuss gewertet.
  IMPLEMENTIERUNG: Setzt Abbruch-Flags, löscht Entity-Buffer, dekrementiert Freigabezähler.
  ERKENNUNG: BOOL das Produktionsabbruch auslöst. "Cancel", "Abbruch", "Abort". Hängt ab von Bediener-Taste oder MES-Signal.

Machine.EntityCounter [INT]: Zähler der freigegebenen Produktionseinheiten.
  VERHALTEN: Wird bei jeder Freigabe inkrementiert, bei Reset auf 0 gesetzt. Zeigt wie viele Teile noch freigegeben sind.
  ERKENNUNG: INT der bei Freigabe hochzählt und bei Zyklusende runterzählt. "EntityCounter", "Freigabe_Zähler", "ReleaseCnt".

Machine.NotifyMachineState [BOOL]: Benachrichtigung bei Zustandsänderung.
  VERHALTEN: Impuls/Flanke wenn sich MachineryItemState oder MachineryOperationMode ändert. Wird verzögert zurückgesetzt.
  ERKENNUNG: BOOL-Flanke die bei Zustandswechsel TRUE wird. Hängt ab von State/Mode Vergleich mit vorherigem Wert.

Machine.OpModeMaintenance [BOOL]: Wartungsmodus aktiv.
  VERHALTEN: Von MES/Bediener gesetzter Modus. Blockiert Produktion, erlaubt Wartungsarbeiten.
  ERKENNUNG: BOOL von extern gesetzt oder über HMI. "Wartung", "Maintenance", "Instandhaltung".

Machine.OpModeTesting [BOOL]: Testmodus aktiv.
  VERHALTEN: Von MES gesetzter Modus für Testproduktion. Teile werden nicht gezählt.
  ERKENNUNG: BOOL von extern. "Test", "Testbetrieb", "Testing".

Machine.OpModePrepare [BOOL]: Vorbereitungsmodus.
  VERHALTEN: Rüstvorgang aktiv. Maschine wird für neue Produktion vorbereitet.
  ERKENNUNG: BOOL das bei Rezeptwechsel oder Rüstvorgang gesetzt wird. "Prepare", "Rüsten", "Setup", "Vorbereitung".

Machine.OperationDetails.State [DWORD]: Maschinenzustand als 32-Bit Bitmask.
  VERHALTEN: Jedes Bit = ein StateBit (Producing=Bit0, ErrorActive=Bit1, etc.). Berechnet aus Einzelsignalen.
  ERKENNUNG: Wird selten direkt gemappt. Eher die Einzelbits (StateBits.*) verwenden.

Machine.OperationDetails.Mode [DWORD]: Betriebsart als 32-Bit Bitmask.
  VERHALTEN: Jedes Bit = ein ModeBit (On=Bit0, Manual=Bit1, etc.). Berechnet aus Einzelsignalen.

Machine.OperationDetails.DowntimeReason [DWORD]: Stillstandsgrund als 32-Bit Bitmask.
  VERHALTEN: Jedes Bit = ein Stillstandsgrund. Berechnet aus Einzelsignalen.

Machine.StateBits.Producing [BOOL]: Hauptprozess läuft, Maschine produziert.
  VERHALTEN: TRUE wenn die Maschine TATSÄCHLICH produziert – nicht nur eingeschaltet oder in Automatik.
  IMPLEMENTIERUNG: Typisch: Automatik-Modus UND Hauptantrieb läuft UND kein Fehler. Oft das wichtigste Signal.
  ERKENNUNG: BOOL das von Automatik-Status UND Prozess-Lauf abhängt. NICHT nur "Automatik ein" – das ist ModeBits.Automatic.
  Unterschied zu Automatic: Automatic = Betriebsart gewählt. Producing = tatsächlich am Produzieren.

Machine.StateBits.ErrorActive [BOOL]: Mindestens ein Fehler/Störung ist aktiv.
  VERHALTEN: TRUE wenn irgendein Fehler aktiv ist – egal ob Maschinen-, Produkt- oder Safety-Fehler.
  IMPLEMENTIERUNG: OR-Verknüpfung aller Fehlerbits oder Ausgang eines Sammelstörungs-FB.
  ERKENNUNG: BOOL das von Störungsbits abhängt. "Sammelstörung", "ErrorActive", "Störung", "Fault". Oft Ausgang eines Error-Handler-FB.

Machine.StateBits.WaitStart [BOOL]: Maschine wartet auf Startbefehl.
  VERHALTEN: TRUE wenn alle Voraussetzungen erfüllt sind (Freigabe da, kein Fehler, Automatik) aber der Start noch nicht gekommen ist.
  IMPLEMENTIERUNG: Typisch: MachineIsReleased AND AutoMode AND NOT Producing AND NOT Error.
  ERKENNUNG: BOOL das von Freigabe + Automatik abhängt aber Producing = false.

Machine.StateBits.WaitOperator [BOOL]: Maschine wartet auf Bediener-Eingriff.
  VERHALTEN: TRUE wenn die Maschine eine manuelle Aktion erfordert (z.B. Teil einlegen, Tür schließen).
  ERKENNUNG: BOOL das von Prozess-Zustand abhängt. "WaitOperator", "Bediener_Eingriff", "Operator_Required".

Machine.StateBits.Preparation [BOOL]: Vorbereitungszyklus läuft.
  VERHALTEN: TRUE während die Maschine sich auf Produktion vorbereitet (Aufheizen, Positionieren).
  ERKENNUNG: BOOL das zeitlich vor Producing aktiv ist. "Vorbereitung", "Preparation", "Warmup".

Machine.StateBits.FollowUp [BOOL]: Nachlauf aktiv.
  VERHALTEN: TRUE nach Ende des Hauptprozesses während die Maschine noch nachläuft (Kühlen, Ausschleusen).
  ERKENNUNG: BOOL das zeitlich nach Producing aktiv ist. "Nachlauf", "FollowUp", "Cooldown".

Machine.StateBits.HomePositioning [BOOL]: Grundstellungsfahrt läuft.
  VERHALTEN: TRUE während die Maschine in ihre Ausgangsposition fährt.
  ERKENNUNG: BOOL das bei Grundstellungsfahrt gesetzt wird. "Grundstellung_fahrt", "Referenzfahrt", "HomePositioning", "Homing".

Machine.StateBits.NoHomePosition [BOOL]: Nicht in Grundstellung.
  VERHALTEN: TRUE wenn die Maschine NICHT in ihrer definierten Ausgangsposition ist.
  ERKENNUNG: Invertiertes Grundstellungs-Signal. NOT "InGrundstellung", "NoHomePosition". Oft ein Endlagenschalter.

Machine.StateBits.ProtectiveDevice [BOOL]: Schutzeinrichtung ausgelöst.
  VERHALTEN: TRUE wenn mindestens eine Schutzeinrichtung aktiv ist (Schutztür offen, Lichtschranke unterbrochen).
  IMPLEMENTIERUNG: OR-Verknüpfung ALLER Schutztür-/Schutzeinrichtungs-Signale. NICHT nur eine einzelne Tür!
  ERKENNUNG: BOOL oder Expression (OR) von Schutztür-Signalen. "Schutztür", "Schutzeinrichtung", "Safety_Door", "Guard".

Machine.ModeBits.On [BOOL]: Maschine eingeschaltet.
  VERHALTEN: TRUE wenn Steuerung eingeschaltet UND kein Notaus aktiv.
  IMPLEMENTIERUNG: Grundbedingung für alle anderen Modi. Typisch: Hauptschütz ein + Safety OK.
  ERKENNUNG: BOOL das die Basis-Betriebsbereitschaft anzeigt. "CONTROL_ON", "Steuerung_Ein", "Power_On", "Machine_On".

Machine.ModeBits.Manual [BOOL]: Handbetrieb aktiv.
  VERHALTEN: TRUE wenn Bediener manuell einzelne Achsen/Funktionen steuern kann. Schließt sich mit Automatic aus.
  ERKENNUNG: BOOL von Betriebsartenwahl. "PULL_ON", "Handbetrieb", "Manual", "Hand". Dependency auf Taste/Schalter.

Machine.ModeBits.SemiAutomatic [BOOL]: Halbautomatik aktiv.
  VERHALTEN: TRUE wenn Maschine schrittweise/einzelzyklusfähig läuft. Bediener startet jeden Zyklus.
  ERKENNUNG: BOOL von Betriebsartenwahl. "SET_ON", "Halbautomatik", "SemiAuto", "Tippbetrieb".

Machine.ModeBits.Automatic [BOOL]: Vollautomatik aktiv.
  VERHALTEN: TRUE wenn Maschine selbstständig Zyklen fährt. Schließt sich mit Manual/Setup aus.
  IMPLEMENTIERUNG: Gesetzt durch Betriebsarten-FB wenn Steuerung ein + Auto-Taste + kein Safety-Fehler.
  ERKENNUNG: BOOL von Betriebsartenwahl. "AUTO_ON", "Automatik", "Automatic". Hängt ab von Taste/Schalter + Freigabe.

Machine.ModeBits.Setup [BOOL]: Einrichtbetrieb aktiv.
  VERHALTEN: TRUE wenn Maschine im Rüst-/Einrichtmodus ist. Für Werkzeugwechsel, Parametrierung.
  ERKENNUNG: BOOL von Betriebsartenwahl. "Setup", "Rüsten", "Einrichten". NICHT gleich Automatik!

Machine.ModeBits.Maintenance [BOOL]: Wartungsmodus.
Machine.ModeBits.Testing [BOOL]: Testmodus.
Machine.ModeBits.Sleep [BOOL]: Standby/Energiesparmodus.
  ERKENNUNG: Ähnlich wie andere ModeBits, von Betriebsartenwahl oder extern gesetzt.

Machine.DowntimeReasonBits.MachineError [BOOL]: Stillstand wegen Maschinenfehler.
  VERHALTEN: TRUE wenn ein maschinenbezogener Fehler den Stillstand verursacht (Motor, Pneumatik, Mechanik).
  ERKENNUNG: BOOL das von maschinenspezifischen Störungsmeldungen abhängt. "Maschinenstörung", "Motorstörung".

Machine.DowntimeReasonBits.SafetyError [BOOL]: Stillstand wegen Safety-Fehler.
  VERHALTEN: TRUE wenn ein sicherheitsrelevanter Fehler vorliegt (Notaus, Safety-SPS).
  ERKENNUNG: BOOL das von Safety-System abhängt. "SAFETY_BAD", "Notaus", "NotHalt", "Emergency_Stop".

Machine.DowntimeReasonBits.ProductError [BOOL]: Stillstand wegen Produktfehler.
  VERHALTEN: TRUE wenn ein Produktqualitäts-Problem den Stillstand verursacht.
  ERKENNUNG: BOOL das von Qualitätsprüfung abhängt. "Produktfehler", "Qualitätsfehler", "Ausschuss".

Machine.DowntimeReasonBits.NoMaterial [BOOL]: Stillstand wegen Materialmangel.
  ERKENNUNG: "Material_Fehlt", "NoMaterial", "Materialmangel", "Leerlauf".

Machine.DowntimeReasonBits.PlannedStop [BOOL]: Geplanter Stillstand.
  ERKENNUNG: "PlannedStop", "Geplanter_Halt", "Schichtwechsel", "Pausenzeit".

Machine.NotifyUserCycleRequest [BOOL]: Bediener fordert Produktionszyklus an.
Machine.DateTimeEntityStarted [LDT]: Zeitstempel wann der aktuelle Zyklus gestartet wurde.

--- PRODUCTION ---

Production.CycleIsRunning [BOOL]: Aktueller Produktionszyklus läuft.
  VERHALTEN: TRUE von Zyklusstart bis Zyklusende. Ähnlich wie Producing aber spezifisch auf den Einzelzyklus.
  IMPLEMENTIERUNG: Gesetzt bei Zyklusstart (Freigabe + Start), zurückgesetzt bei Zyklusende oder Abbruch.
  ERKENNUNG: BOOL mit klarer Start/Stop-Logik. "CycleRunning", "Zyklus_Läuft", "ProcessRunning".

Production.LastCycleOk [BOOL]: Letzter Zyklus war Gutteil.
  VERHALTEN: TRUE wenn der letzte Produktionszyklus ohne Fehler abgeschlossen wurde. FALSE bei Ausschuss.
  IMPLEMENTIERUNG: Gesetzt am Zyklusende basierend auf Qualitätsprüfung. Beeinflusst Gut/Schlecht-Zähler.
  ERKENNUNG: BOOL das am Zyklusende gesetzt wird. "Product_OK", "Gutteil", "IO_Teil", "LastCycleOk". Hängt ab von Prüf-Ergebnis.

Production.NotifyCycleFinished [BOOL]: Zyklusende-Benachrichtigung (Impuls).
  VERHALTEN: Flanke/Impuls wenn ein Zyklus normal beendet wurde. Löst MES-Meldung aus.
  ERKENNUNG: BOOL-Flanke bei Zyklusende. Wird nach Senden automatisch zurückgesetzt.

Production.NotifyCycleAborted [BOOL]: Zyklusabbruch-Benachrichtigung (Impuls).
  VERHALTEN: Flanke wenn ein Zyklus abgebrochen wurde (Fehler, Bediener-Abbruch).

Production.NotifyUserCycleRequest [BOOL]: Bediener fordert Zyklus an.
  VERHALTEN: Bediener drückt Start-Taste und fordert eine Freigabe vom MES an. Impuls.

Production.ShiftCounterCurrent [INT]: Stückzähler aktuelle Schicht.
Production.ShiftCounterPrevious [INT]: Stückzähler vorherige Schicht.
Production.ShiftCounterPrePrevious [INT]: Stückzähler vor-vorherige Schicht.
  ERKENNUNG: INT-Zähler die bei Schichtwechsel rotieren. "Schichtzähler", "ShiftCounter".

Production.ProductionHours [DINT]: Produktionsstunden.
  VERHALTEN: Wird jede Stunde um 1 inkrementiert wenn Producing = TRUE.
  ERKENNUNG: DINT der über Stunden-Timer hochzählt. "Betriebsstunden", "ProductionHours".

Production.DateTimeEntityStarted [LDT]: Zeitstempel Zyklusstart.

Production.RedSignalMES [INT]: Rote Signallampe (Code von MES).
  VERHALTEN: Steuert die rote Warnleuchte am Signalturm. Verschiedene Codes für verschiedene Blinkfrequenzen.
  Codes: 0=aus, 1=Dauer, 2=schnell blinken, 3=langsam blinken, 4=MES-gesteuert.

Production.GreenSignalMES [INT]: Grüne Signallampe.
Production.AccusticSignalMES [INT]: Hupe/akustisches Signal.

--- JOB INFORMATION ---

JobInformation.JobName [STRING]: Auftragsname/-nummer.
  VERHALTEN: Wird von MES geschrieben wenn ein neuer Auftrag gestartet wird. Löst ggf. Rezeptwechsel aus.
  ERKENNUNG: STRING ohne SPS-interne Logik (von extern geschrieben). "Auftragsname", "OrderName", "JobName", "Auftrag_Nr".

JobInformation.ProductName [STRING]: Produktname.
JobInformation.ProductDescription [STRING]: Produktbeschreibung.
JobInformation.CustomerName [STRING]: Kundenname.
JobInformation.JobComment [STRING]: Auftragskommentar.
  ERKENNUNG: Alle von MES geschriebene STRING-Werte. Keine SPS-interne Logik.

JobInformation.JobQuantityPlanned [INT]: Geplante Stückzahl des Auftrags.
  VERHALTEN: Von MES vorgegeben. SPS vergleicht mit Ist-Zähler.
  ERKENNUNG: INT von extern. "Sollmenge", "RequiredPCS", "PlannedQty", "TargetQuantity".

JobInformation.JobPartsCounter [DINT]: Gesamtzähler Teile im Auftrag.
  VERHALTEN: Bei jedem Zyklusende um Cavity inkrementiert. Bei Auftragsreset auf 0.
  ERKENNUNG: DINT-Zähler der bei Zyklusende hochzählt. "Stückzähler", "TotalParts", "PartsCounter".

JobInformation.JobGoodPartsCounter [DINT]: Gutteile im Auftrag.
  VERHALTEN: Nur bei LastCycleOk=TRUE inkrementiert.
  ERKENNUNG: DINT der nur bei Gutteil hochzählt. "Gutteile", "GoodParts", "IO_Teile_Gesamt".

JobInformation.JobBadPartsCounter [DINT]: Schlechtteile im Auftrag.
  VERHALTEN: Nur bei LastCycleOk=FALSE oder ProductError inkrementiert.
  ERKENNUNG: "Schlechtteile", "BadParts", "NIO_Teile", "Ausschuss_Gesamt".

JobInformation.JobCycleCounter [DINT]: Zyklenzähler Auftrag.
JobInformation.JobTestSamplesCounter [DINT]: Prüfmuster Auftrag.
JobInformation.BoxPartsCounter [DINT]: Teile im aktuellen Behälter.
JobInformation.BoxGoodPartsCounter [DINT]: Gutteile im Behälter.
JobInformation.BoxBadPartsCounter [DINT]: Schlechtteile im Behälter.
JobInformation.BoxCycleCounter [DINT]: Zyklen im Behälter.
JobInformation.BoxTestSamplesCounter [DINT]: Prüfmuster im Behälter.
  ERKENNUNG: Gleich wie Job-Zähler aber werden bei Behälterwechsel zurückgesetzt.

JobInformation.MachineCycleCounter [DINT]: Lebensdauer-Zyklenzähler der Maschine.
  VERHALTEN: Wird NIE zurückgesetzt. Zählt seit Inbetriebnahme jeden Zyklus.
  ERKENNUNG: DINT der nur hochzählt. "Gesamtzyklen", "TotalCycles", "MachineLifetimeCycles".

JobInformation.LastCycleTime [DINT]: Letzte Zykluszeit in Millisekunden.
  VERHALTEN: Wird am Zyklusende mit der gemessenen Zeit beschrieben.
  ERKENNUNG: DINT/TIME der die Dauer des letzten Zyklus enthält. "Zykluszeit", "CycleTime", "Taktzeit".

JobInformation.AverageCycleTime [DINT]: Durchschnittliche Zykluszeit in ms.
  VERHALTEN: Gleitender Durchschnitt über die letzten N Zyklen.
  ERKENNUNG: DINT/REAL mit gemitteltem Wert. "Average", "Mittelwert_Takt".

JobInformation.LastPartId [STRING]: ID des zuletzt produzierten Teils.
  VERHALTEN: Wird bei Zyklusende mit der Trace-ID des Teils beschrieben.

JobInformation.Cavity [INT]: Kavität/Nestanzahl pro Zyklus.
  VERHALTEN: Wie viele Teile pro Produktionszyklus entstehen. Kann durch deaktivierte Nester reduziert werden.
  ERKENNUNG: INT, oft als Parameter konfiguriert. "Kavität", "Cavity", "Nestanzahl", "PartsPerCycle".

--- RECIPES ---

Recipes.RecipeIDRunning [STRING]: Aktuell aktives Rezept.
  VERHALTEN: ID des Rezepts das gerade in der Maschine geladen und aktiv ist.
  ERKENNUNG: STRING der das aktuelle Rezept identifiziert. "Recipe_ID", "Rezeptnummer", "Aktuelles_Rezept".

Recipes.RecipeIDBuffered [STRING]: Gepuffertes Rezept (nächstes).
  VERHALTEN: Bereits empfangenes aber noch nicht aktiviertes Rezept. Wird bei nächstem Auftragswechsel aktiv.

Recipes.RecipeIDLastTransferMES [STRING]: Letztes von MES übertragenes Rezept.
Recipes.RecipeNew [BOOL]: Neues Rezept verfügbar.
  VERHALTEN: TRUE wenn ein neues Rezept vom MES empfangen wurde. Wird nach Bestätigung zurückgesetzt.

Recipes.RecipeFinished [BOOL]: Rezeptübertragung abgeschlossen.
Recipes.RecipeValid [BOOL]: Rezept ist gültig und angewendet.
Recipes.RecipeTransferResult [BOOL]: Ergebnis der Übertragung.
Recipes.NotifyRecipeIDChanged [BOOL]: Rezept-ID hat sich geändert (Flanke).

--- ID TRANSFER (Barcode/RFID/Tracking) ---

IdTransfer.TraceIdPLC [STRING]: Trace-ID gelesen durch SPS (Barcode/RFID).
  VERHALTEN: Enthält den zuletzt gescannten Code. Wird bei jedem Scan mit neuem Wert beschrieben.
  IMPLEMENTIERUNG: Scanner liest Code → SPS empfängt über seriell/Profinet → wird in DB geschrieben.
  ERKENNUNG: STRING der sich bei Scan ändert. "Barcode", "RFID", "TraceID", "PartCode", "Scan_Data".

IdTransfer.TraceIdMES [STRING]: Trace-ID bestätigt durch MES.
  VERHALTEN: MES bestätigt den empfangenen Code. Kann sich vom gescannten unterscheiden.

IdTransfer.RequestTraceIdPLC [STRING]: SPS fordert ID an.
IdTransfer.RequestTraceIdMES [STRING]: MES fordert ID an.

IdTransfer.NotifyScan [BOOL]: Scan-Ereignis aufgetreten (Impuls).
  VERHALTEN: Flanke wenn ein neuer Code erfolgreich gelesen wurde.
  ERKENNUNG: BOOL-Flanke die bei Barcode-Lesung TRUE wird. "ScanDone", "CodeRead", "NewBarcode".

IdTransfer.NotifyRelabel [BOOL]: Umetikettierung nötig.
IdTransfer.ScannerId [INT]: Scanner-Identifikation.

--- USER ---

User.UserID [STRING]: Angemeldeter Benutzer.
  VERHALTEN: Enthält die ID des aktuell angemeldeten Bedieners. Leer wenn niemand angemeldet.
  ERKENNUNG: STRING der sich bei An-/Abmeldung ändert. "UserID", "Bediener", "Operator_ID".

User.LoginState [INT]: Anmeldestatus.
  VERHALTEN: 0=Kein Benutzer, 1=Angemeldet, 2=Wechsel, 3=Fehler.
  ERKENNUNG: INT mit diskreten Werten. "LoginState", "Anmeldestatus".

User.UserBarcodePLC [STRING]: Benutzer-Barcode von SPS-Scanner.
User.UserLevel [INT]: Berechtigungsstufe des Benutzers.
User.NotifyUserLogin [BOOL]: Benutzer-Anmeldung Flanke.

--- TOOLS & BATCHES ---

ToolsBatches.ToolId [STRING]: Werkzeug-ID.
  ERKENNUNG: "Werkzeug_ID", "ToolNumber", "Tool_ID", "Formennummer".
ToolsBatches.Batch.ArticleNumber [STRING]: Chargen-Artikelnummer. Von MES.
ToolsBatches.Batch.LotNumber [STRING]: Chargen-Losnummer. Von MES.
ToolsBatches.Batch.Durability [STRING]: Haltbarkeitsdatum der Charge.

--- MACHINE IDENTIFICATION (statische Daten) ---

MachineIdentification.Manufacturer [STRING]: Maschinenhersteller. Statisch konfiguriert.
MachineIdentification.SerialNumber [STRING]: Seriennummer. Statisch.
MachineIdentification.ProductInstanceUri [STRING]: Eindeutige URI der Maschineninstanz.
MachineIdentification.AssetId [STRING]: Asset-Management-ID.
MachineIdentification.ComponentName [STRING]: Maschinenname/Komponentenname.
MachineIdentification.Location [STRING]: Standort.
MachineIdentification.Site [STRING]: Werk/Standort.
MachineIdentification.Building [STRING]: Gebäude.
MachineIdentification.Line [STRING]: Produktionslinie.
MachineIdentification.Group [STRING]: Maschinengruppe.
MachineIdentification.Level [STRING]: Ebene/Stockwerk.
MachineIdentification.Country [STRING]: Land.
MachineIdentification.GlobalRegion [STRING]: Globale Region.
MachineIdentification.Model [STRING]: Maschinenmodell.
MachineIdentification.DeviceClass [STRING]: Geräteklasse.
MachineIdentification.HardwareRevision [STRING]: Hardware-Version.
MachineIdentification.SoftwareRevision [STRING]: PLC-Software-Version.
MachineIdentification.MesRevision [STRING]: MES-Software-Version.
MachineIdentification.ManufacturerUri [STRING]: Hersteller-URI.
MachineIdentification.ProductCode [STRING]: Produktcode.
MachineIdentification.InitialOperationDate [STRING]: Datum der Erstinbetriebnahme.
MachineIdentification.MonthOfConstruction [INT]: Baujahr Monat.
MachineIdentification.YearOfConstruction [INT]: Baujahr Jahr.
MachineIdentification.DataProcessingSystems [STRING]: Angebundene Datensysteme.
MachineIdentification.OperatingHours [DINT]: Betriebsstunden seit Inbetriebnahme.
  VERHALTEN: Wird jede Stunde inkrementiert wenn Maschine eingeschaltet (ModeBits.On = TRUE).
MachineIdentification.SafetyPLC [BOOL]: Safety-SPS vorhanden.
  Alle MachineIdentification-Signale sind typisch STATISCH konfiguriert – nicht durch SPS-Logik berechnet.
  Sie werden einmalig beim Commissioning gesetzt oder von MES geschrieben. Die AI sollte nach statischen
  STRING/INT-Werten in Konfigurations-DBs suchen.

--- ENERGY (Messwerte von Energiemessgeräten) ---

Energy.Electrical.ActivePower [REAL]: Wirkleistung in kW. Von Leistungsmessgerät.
Energy.Electrical.ReactivePower [REAL]: Blindleistung in kVar.
Energy.Electrical.ApparentPower [REAL]: Scheinleistung in kVA.
Energy.Electrical.ActiveEnergy [REAL]: Wirkenergie/Verbrauch in kWh. Zählerstand.
Energy.Electrical.ReactiveEnergy [REAL]: Blindenergie in kVarh.
Energy.Electrical.Voltage [REAL]: Spannung in V.
Energy.Electrical.CurrentL1 [REAL]: Strom Phase L1 in A.
Energy.Electrical.CurrentL2 [REAL]: Strom Phase L2 in A.
Energy.Electrical.CurrentL3 [REAL]: Strom Phase L3 in A.
Energy.Electrical.Frequency [REAL]: Netzfrequenz in Hz.
Energy.Electrical.PowerFactor [REAL]: Leistungsfaktor (cos phi).
Energy.Electrical.Description [STRING]: Beschreibung der Messstelle.

Energy.CompressedAir.Consumption [REAL]: Druckluftverbrauch in m³.
Energy.CompressedAir.MassFlow [REAL]: Druckluft-Durchfluss in kg/h.
Energy.CompressedAir.Pressure [REAL]: Druckluft-Druck in bar.
Energy.CompressedAir.Temperature [REAL]: Druckluft-Temperatur in °C.
Energy.CompressedAir.Description [STRING]: Beschreibung.

Energy.Water.Consumption [REAL]: Wasserverbrauch in m³.
Energy.Water.MassFlow [REAL]: Wasser-Durchfluss in kg/h.
Energy.Water.Pressure [REAL]: Wasserdruck in bar.
Energy.Water.Temperature [REAL]: Wassertemperatur in °C.
Energy.Water.Description [STRING]: Beschreibung.

Energy.Steam.Consumption [REAL]: Dampfverbrauch in kg.
Energy.Steam.MassFlow [REAL]: Dampf-Durchfluss in kg/h.
Energy.Steam.Pressure [REAL]: Dampfdruck in bar.
Energy.Steam.Temperature [REAL]: Dampftemperatur in °C.
Energy.Steam.Description [STRING]: Beschreibung.

Energy.Vacuum.Description [STRING]: Vakuum-Beschreibung.
Energy.Vacuum.PercentToAtmosphere [REAL]: Vakuumniveau in % zur Atmosphäre.

Energy.TechnicalFluid.Consumption [REAL]: Technische Flüssigkeit Verbrauch.
Energy.TechnicalFluid.MassFlow [REAL]: Durchfluss.
Energy.TechnicalFluid.Pressure [REAL]: Druck.
Energy.TechnicalFluid.Temperature [REAL]: Temperatur.
Energy.TechnicalFluid.Description [STRING]: Beschreibung.

Energy.TechnicalGas.Consumption [REAL]: Technisches Gas Verbrauch.
Energy.TechnicalGas.MassFlow [REAL]: Durchfluss.
Energy.TechnicalGas.Pressure [REAL]: Druck.
Energy.TechnicalGas.Temperature [REAL]: Temperatur.
Energy.TechnicalGas.Description [STRING]: Beschreibung.

Energy.Fuels.Consumption [REAL]: Kraftstoffverbrauch.
Energy.Fuels.MassFlow [REAL]: Durchfluss.
Energy.Fuels.Pressure [REAL]: Druck.
Energy.Fuels.Temperature [REAL]: Temperatur.
Energy.Fuels.Description [STRING]: Beschreibung.

  Alle Energy-Signale sind MESSWERTE von Energiemessgeräten (Sentron, PAC3200 etc.) oder Sensoren.
  Sie werden über Profinet/Profibus von den Messgeräten gelesen und in Datenbausteine geschrieben.
  Die AI sollte nach REAL-Werten suchen die von Messbausteinen oder Analogeingängen kommen und
  Einheiten-bezogene Kommentare haben (kW, bar, °C, m³, etc.).

--- PROCESS VALUES (maschinenspezifisch) ---

ProcessValues.Custom1-5 [REAL]: Maschinenspezifische Prozesswerte.
  VERHALTEN: Platzhalter die pro Maschine individuell befüllt werden. Können alles sein:
  Temperatur, Druck, Drehzahl, Geschwindigkeit, Dicke, Kraft, Drehmoment etc.
  ERKENNUNG: REAL-Werte die typische Prozessgrößen darstellen. Suche nach Analogwerten
  mit Einheiten-Kommentaren (°C, bar, mm/min, U/min, N, Nm etc.).
`;

module.exports = { CTBASE_RULES };
