import { Navbar } from './components/Navbar'
import { Hero } from './components/Hero'
import { Features } from './components/Features'
import { Platforms } from './components/Platforms'
import { HowItWorks } from './components/HowItWorks'
import { CallToAction } from './components/CallToAction'
import { Footer } from './components/Footer'

export default function App() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <Platforms />
        <HowItWorks />
        <CallToAction />
      </main>
      <Footer />
    </>
  )
}
