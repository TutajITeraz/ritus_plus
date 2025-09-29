import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from "@/components/ui/provider"
import AppTableOnly from './AppTableOnly.jsx';
import { StrictMode } from 'react';

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(
    <StrictMode>
        <Provider forcedTheme="light" >
            <AppTableOnly />
        </Provider>
    </StrictMode>
)
