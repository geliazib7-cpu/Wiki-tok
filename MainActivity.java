package app.walkieclaves.radio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RadioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
